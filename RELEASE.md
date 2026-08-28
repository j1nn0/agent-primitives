# Release procedure

The release workflow uses one guarded path for the package families listed below. It never bumps
versions and it never publishes source directories: each release is packed with
pnpm and the resulting tarballs are published with npm.

## Package families

| Family | Core package | Pi adapter package | Current registry status |
| --- | --- | --- | --- |
| `context-guard` | `packages/context-guard` → `@j1nn0/agent-context-guard` `0.1.1` | `packages/context-guard-pi` → `@j1nn0/agent-context-guard-pi` `0.1.1` | Published |
| `agent-state` | `packages/agent-state` → `@j1nn0/agent-state` `0.1.0` | `packages/agent-state-pi` → `@j1nn0/agent-state-pi` `0.1.0` | Published |
| `agent-progress` | `packages/agent-progress` → `@j1nn0/agent-progress` `0.1.0` | `packages/agent-progress-pi` → `@j1nn0/agent-progress-pi` `0.1.0` | Published |
| `agent-retry-guard` | `packages/agent-retry-guard` → `@j1nn0/agent-retry-guard` `0.1.0` | `packages/agent-retry-guard-pi` → `@j1nn0/agent-retry-guard-pi` `0.1.0` | Published |
| `agent-evidence` | `packages/agent-evidence` → `@j1nn0/agent-evidence` `0.1.0` | `packages/agent-evidence-pi` → `@j1nn0/agent-evidence-pi` `0.1.0` | Published |
| `agent-handoff` | `packages/agent-handoff` → `@j1nn0/agent-handoff` `0.1.0` | `packages/agent-handoff-pi` → `@j1nn0/agent-handoff-pi` `0.1.0` | Published |
| `agent-budget` | `packages/agent-budget` → `@j1nn0/agent-budget` `0.1.0` | `packages/agent-budget-pi` → `@j1nn0/agent-budget-pi` `0.1.0` | Published
| `agent-tool-policy` | `packages/agent-tool-policy` → `@j1nn0/agent-tool-policy` `0.1.0` | `packages/agent-tool-policy-pi` → `@j1nn0/agent-tool-policy-pi` `0.1.0` | Not published (bootstrap required) |

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

For the current Agent State and Progress manifests, select the matching family
with `core_version=0.1.0` and `pi_version=0.1.0`. The workflow defaults remain
`0.1.1` so the already-published Context Guard release remains the safe default.
For the current Retry Guard manifests, select family `agent-retry-guard` with `core_version=0.1.0` and `pi_version=0.1.0`. The workflow defaults remain `0.1.1` so the already-published Context Guard release remains the safe default.
For the current Evidence manifests, select family `agent-evidence` with `core_version=0.1.0` and `pi_version=0.1.0`. The workflow defaults remain `0.1.1` so the already-published Context Guard release remains the safe default.
For the current Agent Handoff manifests, select family `agent-handoff` with `core_version=0.1.0` and `pi_version=0.1.0`. The workflow defaults remain `0.1.1` so the already-published Context Guard release remains the safe default.
For the current Agent Budget manifests, select family `agent-budget` with `core_version=0.1.0` and `pi_version=0.1.0`. The workflow defaults remain `0.1.1` so the already-published Context Guard release remains the safe default.
For the current Agent Tool Policy manifests, select family `agent-tool-policy` with `core_version=0.1.0` and `pi_version=0.1.0`. The workflow defaults remain `0.1.1` so the already-published Context Guard release remains the safe default.

### Validate versus publish

`validate` performs no registry publication and does not require the confirmation
literal. It installs dependencies from the frozen lockfile, rebuilds from clean
`dist` directories, runs lint, typecheck, tests, package checks, and examples,
performs pnpm dry runs, audits both packed tarballs, and runs the selected
family's fresh-consumer smoke. The local smoke installs both tarballs by absolute
path in one `npm install`; it does not resolve the family core from the registry.

`publish` repeats the safety checks, reasserts the manifest versions, performs an
anonymous registry preflight, and publishes only when the requested registry
state is safe. The publish job then verifies the core on the registry and verifies
its provenance before publishing the adapter. Finally it verifies the adapter and
its provenance, and the anonymous `registry-smoke` job exercises both packages.

## Trusted Publishing and first-publish bootstrap

The release path is tokenless Trusted Publishing only:

- no `NPM_TOKEN`;
- no `NODE_AUTH_TOKEN`;
- no `secrets.*` expression; and
- no token-authenticated `.npmrc` or fallback authentication.

The workflow uses job-level `contents: read` permissions everywhere, with
`id-token: write` only on `publish`. It declares no GitHub Actions
`environment:`. Do not add a token or an environment to the release path.

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

For any family, the required order is:

1. pack the core and adapter tarballs with pnpm;
2. publish the core tarball with `npm publish --access public --provenance`;
3. verify the core registry manifest and provenance;
4. publish the adapter tarball with the same flags; and
5. verify the adapter registry manifest and provenance.

The adapter is never published before its core. The packed audits require the
expected name and version, `LICENSE`, `README.md`, `dist/`, and (for the adapter)
`pi.extensions` targets. They reject workspace dependencies, forbidden test and
benchmark paths, `.git`, `.npmrc`, nested tarballs, absolute `/home/` paths, and
`/home/` in file contents. The adapter dependency must be exactly `^<core_version>`
after pnpm rewrites `workspace:^` during packing.

Each provenance response must contain the npm publish predicate and SLSA v1. The
SLSA statement must identify:

- repository: `https://github.com/j1nn0/agent-primitives`;
- workflow: `.github/workflows/release.yml`;
- ref: `refs/heads/main`; and
- the dispatched commit (`github.sha`).

The guard in `scripts/guard-release-workflow.mjs` checks these static invariants,
including the family pairing, permissions, trigger, action pins, tokenless
policy, tarball operands, and core-before-adapter provenance ordering. The
negative-control suite is available as `pnpm test:release-guard`.

## Registry recovery

The publish preflight refuses to republish an existing version. It also refuses
an inconsistent state where the adapter exists but the core does not. If the
core exists and the adapter does not, the default is to stop; use
`allow_existing_core=true` only after an explicit decision to verify the existing
core and publish the missing adapter.

Inspect the public registry before re-dispatching after a timeout. Registry and
attestation reads use bounded retries because new releases can take time to
propagate.

## Required sequence

1. Dispatch the selected family in `validate` mode from `main` and wait for the
   complete validation job to pass.
2. Dispatch the same family and versions in `publish` mode with the exact
   family-aware confirmation literal.
3. Let the workflow finish its core publication, core registry/provenance checks,
   adapter publication, adapter checks, and anonymous registry smoke.

After any required first-publish bootstrap, no manual publish, tag, GitHub Release, or version bump is part of the normal release procedure.
