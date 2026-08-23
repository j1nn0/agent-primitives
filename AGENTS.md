# Repository guidance

This is a pnpm workspace of small, composable agent primitives.

## Design boundaries

- Keep core primitives harness-agnostic: accept explicit inputs and return plain, serializable data.
- Put runtime lifecycle behavior in harness adapters, not core packages.
- Preserve fail-safe behavior and privacy defaults; uncertainty must remain visible, with no implicit network calls, telemetry, persistence, or hidden output.

## Changes

- Follow the nearest package README and existing tests.
- Keep diffs focused. Update tests for behavior changes and documentation for public API changes.
- Run checks from the repository root. Run `pnpm build` before `pnpm typecheck`, `pnpm test`, or `pnpm example`; also run `pnpm lint` and `pnpm check:package`.
