# Release procedure

This repository publishes two packages:

- `@j1nn0/agent-context-guard` (core) — `packages/context-guard`
- `@j1nn0/agent-context-guard-pi` (Pi adapter) — `packages/context-guard-pi`

The first release publishes both packages at their current versions, `0.1.0`. The
core must be available on the registry before the adapter because the packed
adapter depends on the core as `^0.1.0`.

## Primary path: GitHub Actions

Use [`.github/workflows/release.yml`](.github/workflows/release.yml), whose
workflow name is **Release**. It is `workflow_dispatch` only: it has no push,
pull-request, schedule, or release trigger, and it never publishes because of a
push or pull request.

### Prerequisites

- The selected ref must be `main`, and the release commit must remain the current
  `main` commit when publishing starts.
- Node.js `24.x` is used by the workflow. The repository pins `pnpm@10.34.5` in
  its root `package.json`.
- Before the first publish, create the repository secret named **`NPM_TOKEN`**.
  Do not put a token value in this document. It should be a granular access token
  with bypass 2FA enabled and access limited to the `@j1nn0` scope.

### Dispatch inputs

| Input | Meaning |
| --- | --- |
| `mode` | Required choice: `validate` or `publish`. It defaults to `validate`. |
| `core_version` | Required string for the core manifest version. It defaults to `0.1.0`. |
| `pi_version` | Required string for the Pi adapter manifest version. It defaults to `0.1.0`. |
| `confirmation` | Optional string, empty by default. It is ignored in validation mode. In publish mode it must equal exactly `publish-<core_version>-<pi_version>`. |
| `allow_existing_core` | Boolean, default `false`. Use only for deliberate partial recovery when the requested core version is already present and the adapter version is not. |

For this first release, the publish confirmation is exactly
`publish-0.1.0-0.1.0`. The workflow validates both version formats and compares
both inputs with the package manifests; it never writes or bumps a version.

### Required sequence

1. Dispatch **Release** in `validate` mode from `main`, normally with the two
   `0.1.0` defaults. Wait for the complete validation job to finish successfully.
2. Only after validation is green, dispatch **Release** again in `publish` mode
   for the same versions and with the exact confirmation literal. The publish
   run checks that it is still on `main`, that `main` has not advanced after the
   dispatch, and that the checkout is clean.
3. Let the workflow publish the core first, verify it anonymously on the npm
   registry, publish the adapter second, and verify the adapter's version and
   core dependency afterward.

Validation installs from the frozen lockfile, runs lint, rebuilds both packages
from a clean `dist`, runs typecheck and tests, runs package checks and the
example, performs pnpm dry runs, audits both packed tarballs, and runs a fresh
consumer smoke test. The local smoke installs both tarballs in one npm install
command because the adapter cannot resolve the unpublished core by itself.
A dispatch in `validate` mode ends after this job; the publish job and registry smoke are skipped.

### Registry state handling

The publish job performs an anonymous version preflight and uses this state
machine. It never republishes an existing version or uses force.

- **State A — neither version exists:** publish the core, verify its name,
  version, and repository, then publish the adapter and verify its version and
  dependency.
- **State B — core exists, adapter does not:** fail by default with a partial
  recovery message. If `allow_existing_core=true` is deliberately selected on a
  new dispatch, verify that the existing core reports the expected name and
  version and a repository URL containing `j1nn0/agent-primitives`; then publish
  only the adapter and perform the normal final verification.
- **State C — adapter exists, core does not:** fail immediately as an
  inconsistent registry state, print both preflight results, and publish
  nothing. The workflow does not repair this state automatically.
- **State D — both versions exist:** fail with an already-released message and
  publish nothing.

For the State B recovery procedure, first inspect the failed preflight and the
registry independently, then re-dispatch **Release** in publish mode with the
same versions, the exact confirmation, and `allow_existing_core=true`. Do not
use that switch for a normal first release or to bypass a failed identity check.

### Anonymous post-publish smoke

After the publish job succeeds, `registry-smoke` checks out the dispatched
commit and installs both exact versions directly from the public registry in a
fresh directory. It does not reference `NPM_TOKEN`, uses one npm install command,
exercises the core guard and literal verifier (including a lost critical item),
imports the adapter, checks its packed dependency, and prints the installed
`@earendil-works/pi-coding-agent` peer version. This is an anonymous public-access
check, not a token-authenticated check.

### Why pnpm and the CI guards are required

Plain `npm publish` is forbidden here. Publishing must use `pnpm publish` because
pnpm rewrites the adapter's `workspace:^` dependency to `^0.1.0` while packing.
Plain npm leaves the literal `workspace:^` in the published manifest, producing
an uninstallable adapter; even an npm dry run can report success for that broken
artifact.

`--no-git-checks` is required in Actions because `actions/checkout` uses a
detached HEAD and pnpm's normal branch, cleanliness, and up-to-date checks then
fail in CI. The workflow compensates before any build or publish operation with
an exact dispatched-commit checkout, a `main` ref guard, a comparison with the
current `origin/main`, and a clean-tree guard. The publish commands remain
`pnpm publish --access public --no-git-checks`.

The workflow never bumps versions, never commits, never pushes, and never creates
git tags or GitHub Releases. It only validates and publishes the already-checked-
out manifests when the explicit dispatch inputs and registry guards allow it.

## Trusted publishing and provenance follow-up

The first release intentionally authenticates with `NPM_TOKEN` and does not use
provenance or an `id-token` permission. npm requires a package to exist on the
registry before trusted publishing can be configured for it, so trusted
publishing and provenance are a deliberate follow-up after the first release,
not part of this workflow.

## Secondary path: Emergency manual fallback

Use this path only when the GitHub Actions primary path is unavailable. It is
kept as an emergency fallback for the current first release and still requires
`pnpm publish`; never use plain npm to publish either package. Do not edit the
package versions as part of this procedure: confirm that both manifests remain
`0.1.0`.

1. Start from a clean checkout of the current `main` commit, with local `main`
   matching its remote. Use Node.js `>=22.12.0` and pnpm `10.34.5`, and use an
   npm account with publish rights for the `@j1nn0` scope.
2. Install and rebuild from clean output:

   ```sh
   pnpm install --frozen-lockfile
   rm -rf packages/context-guard/dist packages/context-guard-pi/dist
   pnpm build
   ```

3. Run the same checks as CI: `pnpm lint`, `pnpm typecheck`, `pnpm test`
   (expected total: 299 tests, 30 core plus 269 adapter), `pnpm check:package`,
   and `pnpm example`.
4. From each package directory, run the required dry run:

   ```sh
   pnpm publish --dry-run --access public --no-git-checks
   ```

5. Pack both packages to a temporary directory outside the repository and
   inspect the unpacked manifests:

   ```sh
   mkdir -p /tmp/agent-primitives-release
   pnpm --filter @j1nn0/agent-context-guard pack --pack-destination /tmp/agent-primitives-release
   pnpm --filter @j1nn0/agent-context-guard-pi pack --pack-destination /tmp/agent-primitives-release
   ```

   Confirm the adapter dependency is exactly
   `@j1nn0/agent-context-guard: ^0.1.0` and not `workspace:^`; confirm its
   `pi.extensions` target exists; confirm both archives contain `LICENSE`,
   `README.md`, `dist/`, and `src/`; and reject tests, benchmarks, `.git`,
   `.npmrc`, tarballs, or files containing `/home/`. Neither package defines a
   `prepack`, `prepare`, or `prepublishOnly` script, so the clean rebuild and
   tarball inspection are the stale-artifact checks.
6. In a separate scratch directory, initialize a consumer and install both
   tarballs in one command:

   ```sh
   cd /tmp/agent-primitives-release
   mkdir -p consumer && cd consumer
   npm init -y
   npm install ../j1nn0-agent-context-guard-0.1.0.tgz ../j1nn0-agent-context-guard-pi-0.1.0.tgz
   ```

   Import both package entries and exercise the core guard, snapshot, literal
   verifier, and missing-critical-item report before publishing. Do not install
   the adapter tarball alone: until the core is on the registry, that install
   cannot resolve its dependency.
7. Publish the core first and stop if it fails:

   ```sh
   cd packages/context-guard
   pnpm publish --access public --no-git-checks
   npm view @j1nn0/agent-context-guard@0.1.0 name version repository
   ```

8. Only after the core registry check succeeds, publish and verify the adapter:

   ```sh
   cd packages/context-guard-pi
   pnpm publish --access public --no-git-checks
   npm view @j1nn0/agent-context-guard-pi@0.1.0 name version dependencies
   ```

Read the packed `README.md` from each archive as its npm package page and
confirm that it is accurate and contains no publication-status claim that this
release would falsify.
If a manual publish stops midway, do not retry blindly. Inspect both requested
versions with `npm view`, identify the equivalent registry state A/B/C/D, and
stop rather than force or silently repair an inconsistent state.
