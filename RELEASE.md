# Release procedure

The release workflow uses one guarded path for two package families. It never bumps
versions and it never publishes source directories: each release is packed with
pnpm and the resulting tarballs are published with npm.

## Package families

| Family | Core package | Pi adapter package | Current registry status |
| --- | --- | --- | --- |
| `context-guard` | `packages/context-guard` → `@j1nn0/agent-context-guard` `0.1.1` | `packages/context-guard-pi` → `@j1nn0/agent-context-guard-pi` `0.1.1` | Published |
| `agent-state` | `packages/agent-state` → `@j1nn0/agent-state` `0.1.0` | `packages/agent-state-pi` → `@j1nn0/agent-state-pi` `0.1.0` | Implemented, not published; npm currently returns 404 |

The Agent State pair is present in the repository, but it is not installable from
npm today. Its first release must follow the bootstrap procedure below.

## Primary path: GitHub Actions

Use [`.github/workflows/release.yml`](.github/workflows/release.yml), whose
workflow name is **Release**. It is `workflow_dispatch` only. The workflow
filename is part of the npm Trusted Publisher identity and must remain exactly
`release.yml`.

### Dispatch inputs and target selection

- `family` is required and selects exactly one family: `context-guard` or
  `agent-state`. It defaults to `context-guard`.
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

For the current Agent State manifests, select `family=agent-state` with
`core_version=0.1.0` and `pi_version=0.1.0`. The workflow defaults remain
`0.1.1` so the already-published Context Guard release remains the safe default.

### Validate versus publish

`validate` performs no registry publication and does not require the confirmation
literal. It installs dependencies from the frozen lockfile, rebuilds from clean
`dist` directories, runs lint, typecheck, tests, package checks, and examples,
performs pnpm dry runs, audits both packed tarballs, and runs the selected
family's fresh-consumer smoke. The local smoke installs both tarballs by absolute
path in one `npm install`; it does not resolve the Agent State core from npm.

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
exist on the npm registry. Therefore the first versions of
`@j1nn0/agent-state` and `@j1nn0/agent-state-pi` must each be published once by a
human outside CI. This is documentation only; the workflow contains no bootstrap
automation. After each package exists, configure its npm Trusted Publisher
separately with:

- owner: `j1nn0`;
- repository: `agent-primitives`;
- workflow filename: `release.yml`; and
- environment: none.

Only after both per-package Trusted Publisher settings are configured can the
Agent State pair use the normal publish dispatch. A bootstrap publish performed
outside a supported CI provider cannot carry provenance, so it is not a
substitute for the provenance checks on subsequent Trusted Publishing releases.

## Ordering and artifact integrity

For either family, the required order is:

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
