# Release procedure (manual)

This repository publishes two independent packages:

- `@j1nn0/agent-context-guard` (core) — `packages/context-guard`
- `@j1nn0/agent-context-guard-pi` (Pi adapter) — `packages/context-guard-pi`

Versions are independent, but the **first release ships both at their current
versions (0.1.0)**. Publish the core **before** the adapter: the packed adapter
manifest depends on `@j1nn0/agent-context-guard` as `^0.1.0`, and that range
must resolve from the registry before the adapter itself is published.

## Preconditions

- Clean working tree; local `main` matches `origin/main`.
- Node.js `>=22.12.0` and pnpm installed (root `packageManager` is
  `pnpm@10.34.5`).
- npm account with publish rights to the `@j1nn0` scope.
- **`pnpm publish --access public` is the required publish command — never plain
  `npm publish` from the working tree.** `pnpm publish` rewrites the
  `workspace:^` dependency to `^0.1.0` in the packed manifest, so the
  adapter has an installable `^0.1.0` dependency. Plain `npm publish` ships
  the literal `workspace:^` range and produces an uninstallable adapter.
  Worse, `npm publish --dry-run` reports success anyway while carrying that
  broken range; a green npm dry-run is not evidence of a publishable artifact.

## Checklist

Run the steps in order, from the repository root unless a step says otherwise.

1. `git pull --ff-only && git status --short` — the status output must be empty.
2. Choose/set versions. Both packages are currently `0.1.0`. If this release
   needs different versions, edit `packages/context-guard/package.json` and
   `packages/context-guard-pi/package.json` now. This step is explicit — do not
   skip it.
3. `pnpm install --frozen-lockfile`
4. Remove stale build output (`rm -rf packages/context-guard/dist
   packages/context-guard-pi/dist`), then `pnpm build`.
5. Run the validated checks from the repository root:
   - `pnpm lint`.
   - `pnpm typecheck`.
   - `pnpm test` — expect 299 tests: 30 core + 269 adapter.
   - `pnpm check:package` — runs publint and attw for both packages.
   - `pnpm example`.
   - From each package directory, run `pnpm publish --dry-run --access public --no-git-checks`.
6. Pack both packages to a temporary directory outside the repository:
   `mkdir -p /tmp/agent-primitives-release && pnpm --filter @j1nn0/agent-context-guard pack --pack-destination /tmp/agent-primitives-release && pnpm --filter @j1nn0/agent-context-guard-pi pack --pack-destination /tmp/agent-primitives-release`
7. Inspect both tarballs (unpack and read the manifests, e.g.
   `tar -xzf ... -C <scratch>`). Verify:
   - the adapter's unpacked `package.json` shows
     `"@j1nn0/agent-context-guard": "^0.1.0"` — not `workspace:^`;
   - the adapter manifest still has its `pi.extensions` entry
     (`"./dist/extension.js"`);
   - each tarball contains `LICENSE`, `README.md`, `dist/`, and `src/`;
   - no tests, benchmarks, or temporary artifacts are included.

   Neither package defines a `prepack`, `prepare`, or `prepublishOnly` script. The clean rebuild in step 4 and tarball inspection in step 7 are the checks that prevent a stale or dist-less tarball; do not add such a script.
8. Required end-to-end smoke in a scratch directory outside the repository. Initialize a fresh consumer and install both tarballs in a **single** `npm install` command:
   `npm init -y && npm install /tmp/agent-primitives-release/j1nn0-agent-context-guard-0.1.0.tgz /tmp/agent-primitives-release/j1nn0-agent-context-guard-pi-0.1.0.tgz`,
   then import both package entries and run them once. Do not install the adapter tarball alone: until the core is on the registry, that install returns a 404 for `@j1nn0/agent-context-guard`; this is expected before the first publish and is not an artifact failure.
9. If versions changed, commit the version bump with a conventional message
   (for example `chore: release @j1nn0/agent-context-guard@0.1.0` and
   `chore: release @j1nn0/agent-context-guard-pi@0.1.0`), push, and wait for CI
   to go green before publishing.
10. Publish the **core** from its package directory. If this publish fails, stop the
    release before publishing the adapter:
    `cd packages/context-guard && pnpm publish --access public --no-git-checks`
11. Verify the registry: `npm view @j1nn0/agent-context-guard@<version>` shows
    the expected version.
12. Publish the **adapter** the same way from its package directory:
    `cd packages/context-guard-pi && pnpm publish --access public --no-git-checks`,
    then verify: `npm view @j1nn0/agent-context-guard-pi@<version>`.
13. Read the packed `README.md` from each tarball as its npm package page. Verify
    that it reads correctly and contains no publication-status claim that this
    release would falsify; no post-publish documentation flip commit is needed.
14. A `pkg@version` git tag and/or a GitHub release may be added later. This
    is undecided — do not improvise new release mechanics here.

## Provenance

The first release is a **manual local publish without npm provenance**. For a
non-trusted-publishing publish, `--provenance` is the relevant flag; that path
requires npm CLI 9.5.0 or later, a cloud-hosted CI runner, and a public
`repository` field matching where you publish from. This procedure does not use
that flag.

Trusted publishing is the intended follow-up for later releases. When trusted
publishing is used from GitHub Actions or GitLab CI/CD, npm generates provenance
automatically; do not add `--provenance`. It requires npm CLI 11.5.1 or later,
Node 22.14.0 or higher, workflow permission `id-token: write`, and a cloud-hosted
runner; self-hosted runners are not supported, and provenance generation is not
supported for private repositories.

A trusted publisher is configured in the settings for the package on npmjs.com
(`Packages -> <package> -> Settings -> Trusted publishing`). Because that package
must already exist on the registry, trusted publishing cannot be configured
before this first release. Setting up trusted publishing is deliberately **not**
part of this release procedure.

## Rollback and safety

- Never force-push tags.
- If a publish fails midway, do not republish silently: first check the actual
  registry state with `npm view @j1nn0/agent-context-guard` (and
  `npm view @j1nn0/agent-context-guard-pi`) before retrying or changing
  anything.