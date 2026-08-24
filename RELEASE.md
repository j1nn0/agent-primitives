# Release procedure

This repository publishes two packages:

- `@j1nn0/agent-context-guard` (core) — `packages/context-guard`
- `@j1nn0/agent-context-guard-pi` (Pi adapter) — `packages/context-guard-pi`

The `0.1.1` release publishes both packages. The core must be available on the
registry before the adapter because the packed adapter depends on the core as
`^0.1.1`.

## Primary path: GitHub Actions

Use [`.github/workflows/release.yml`](.github/workflows/release.yml), whose
workflow name is **Release**. It is `workflow_dispatch` only: it has no push,
pull-request, schedule, release, or tag trigger.

### Trusted publishing prerequisites

Configure npm Trusted Publishing separately for both packages with exactly these
GitHub values:

- owner: `j1nn0`
- repository: `agent-primitives`
- workflow filename: `release.yml`
- environment: none

The workflow filename is part of the trusted-publisher match. Do not rename
`release.yml`. Do not add a GitHub Actions job environment: an `environment:`
key changes the OIDC subject claim and breaks the match.
Changing any of these identity inputs — including renaming the workflow, transferring the repository, or adding an environment — requires reconfiguring the Trusted Publisher on npm before releasing.

The workflow authenticates to npm through Trusted Publishing only. There is no token fallback: it does not use `NPM_TOKEN`, a repository npm token secret, or a token-authenticated `.npmrc`. Both packages are configured on npm to require two-factor authentication and to disallow bypass-2FA tokens. The publish job has job-level `contents: read` and `id-token: write`; the `validate` and `registry-smoke` jobs have only job-level `contents: read`, and no other job receives `id-token`.

Trusted publishing requires npm CLI `11.5.1` or newer and Node.js `22.14.0` or
newer. The workflow uses the Node `24.x` runner, which already satisfies both
requirements, so it does not upgrade npm globally. The repository uses
`pnpm@10.34.5`.

### Supply-chain and release integrity

The release contract is deliberately offline-checkable. The artifact path is `pnpm pack` followed by `npm publish` of the resulting tarball; publishing a package directory is not part of the path. Provenance is mandatory, and the workflow now verifies its SLSA v1 source identity — repository, workflow path, ref, and released commit — with the core checked before the adapter is published.

Both workflows pin every action to a commit SHA and keep a same-line version comment. Dependabot proposes weekly GitHub Actions updates. Because `release.yml` is `workflow_dispatch` only, a Dependabot pull request cannot trigger the release workflow. CI runs `pnpm check:release`, which parses both workflows offline and asserts the release trigger, job dependency and permission boundaries, absence of environments and token references, pack/publish/provenance ordering, tarball publishing flags, setup-node registry configuration, and action-pin format.

Deferred decisions: future tags would use a package-specific `name@version` form, but no tags are created yet. GitHub Releases are deliberately not used for now.

### Dispatch inputs

| Input | Meaning |
| --- | --- |
| `mode` | Required choice: `validate` or `publish`. It defaults to `validate`. |
| `core_version` | Required string for the core manifest version. It defaults to `0.1.1`. |
| `pi_version` | Required string for the Pi adapter manifest version. It defaults to `0.1.1`. |
| `confirmation` | Optional string, empty by default. In publish mode it must equal exactly `publish-<core_version>-<pi_version>`. |
| `allow_existing_core` | Boolean, default `false`. Use only for deliberate partial recovery when the requested core version is already present and the adapter version is not. |

For this release, the publish confirmation is exactly
`publish-0.1.1-0.1.1`. The workflow validates both version formats and compares
both inputs with the package manifests; it never writes or bumps a version.

### Required sequence

1. Dispatch **Release** in `validate` mode from `main`, normally with the two
   `0.1.1` defaults. Wait for the complete validation job to finish successfully.
2. Dispatch **Release** again in `publish` mode for the same versions and with
   the exact confirmation literal. The publish run checks that it is still on
   `main`, that `main` has not advanced after dispatch, and that the checkout is
   clean.
3. Let the workflow pack both packages, publish the core first, verify its
   registry manifest and provenance, publish the adapter second, and verify its
   registry manifest and provenance.

Validation installs from the frozen lockfile, runs lint, rebuilds both packages
from a clean `dist`, runs typecheck and tests, runs package checks and the
example, performs pnpm dry runs, audits both packed tarballs, and runs a fresh
consumer smoke test. The local smoke installs both tarballs in one npm install
because the adapter cannot resolve the unpublished core by itself.

### Publish artifact path

The publish job packs both packages into a temporary directory with pnpm:

```sh
pnpm --filter @j1nn0/agent-context-guard pack --pack-destination "$RUNNER_TEMP/publish-artifacts"
pnpm --filter @j1nn0/agent-context-guard-pi pack --pack-destination "$RUNNER_TEMP/publish-artifacts"
```

The workflow audits the resulting tarballs before publishing. In particular, it
checks the package manifests and versions, rejects `workspace:` dependencies,
requires the adapter dependency to be exactly `^0.1.1`, and checks that every
`pi.extensions` target exists in the adapter tarball.

This path is intentional. pnpm performs the workspace-protocol rewrite while
packing; publishing from the adapter package directory with npm would leave the
literal `workspace:^` dependency in the artifact. npm then publishes the
finished tarball through its supported OIDC Trusted Publishing path:

```sh
npm publish <tarball-path> --access public --provenance
```

`--provenance` is explicit so a prerequisite or CLI regression fails the release
rather than silently publishing without an attestation. The pnpm publication
commands in validation are dry runs only; the actual publish commands are the
two npm tarball publishes above.

### Registry state handling

The publish job performs an anonymous version preflight and uses this state
machine. It never republishes an existing version or uses force.

- **State A — neither version exists:** publish the core, verify its name,
  version, repository, and provenance, then publish the adapter and verify its
  version, dependency, and provenance.
- **State B — core exists, adapter does not:** fail by default with a partial
  recovery message. If `allow_existing_core=true` is deliberately selected on a
  new dispatch, verify the existing core's identity and provenance, then publish
  only the adapter and perform the normal final verification.
- **State C — adapter exists, core does not:** fail immediately as an
  inconsistent registry state and publish nothing.
- **State D — both versions exist:** fail with an already-released message and
  publish nothing.

Registry reads and attestation reads use the same bounded retry window. A
newly-created version or attestation can take several minutes to appear on npm's
public read paths. A timeout means propagation was slow, not that the publish
was necessarily lost: inspect the registry before re-dispatching.

### Provenance verification

For each package, the workflow requires HTTP 200 from the npm attestations
endpoint and checks for both predicate types:

- `https://github.com/npm/attestation/tree/main/specs/publish/v0.1`
- `https://slsa.dev/provenance/v1`
The SLSA v1 predicate is located by its predicate type and must identify the source repository as `https://github.com/j1nn0/agent-primitives`, the workflow path as `.github/workflows/release.yml`, the ref as `refs/heads/main`, and the released commit. The core identity check runs before the adapter publish, so a core provenance failure prevents the adapter from being published.

For example:

```text
https://registry.npmjs.org/-/npm/v1/attestations/@j1nn0%2Fagent-context-guard@0.1.1
https://registry.npmjs.org/-/npm/v1/attestations/@j1nn0%2Fagent-context-guard-pi@0.1.1
```

The final secret-free `registry-smoke` job installs the exact public versions,
exercises both packages, and runs `npm audit signatures`. That command's output
is printed and the job fails if it does not report verified attestations.

## Supported recovery

If a publish is interrupted, inspect the requested versions and re-dispatch the
workflow rather than publishing manually. When the core is published but the
adapter is not, use `allow_existing_core=true` for the deliberate State B
partial-recovery dispatch; the workflow still verifies the existing core before
publishing the adapter.

A manual local publish is no longer supported: it cannot provide the required
provenance through this release path and would require a long-lived npm token
that the project is deliberately removing. Releases before `0.1.1` were
published with a token; `0.1.1` and later use Trusted Publishing.
