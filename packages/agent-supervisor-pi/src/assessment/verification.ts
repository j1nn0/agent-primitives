import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

/**
 * Closed set of deterministic verification classifications. The assessment model does not choose
 * these values; the Kernel assigns them from trusted tool provenance and transient tool input.
 */
export const SUPERVISOR_VERIFICATION_KINDS = [
  'test',
  'lint',
  'typecheck',
  'build',
  'validation',
  'repository-inspection',
  'read-back',
] as const;

export type SupervisorVerificationKind = (typeof SUPERVISOR_VERIFICATION_KINDS)[number];

export const SUPERVISOR_COMPLETION_SUPPORTING_KINDS = [
  'test',
  'lint',
  'typecheck',
  'build',
  'validation',
  'read-back',
] as const satisfies readonly SupervisorVerificationKind[];


/** A deliberately small view of the effective registry returned by Pi. */
export type SupervisorToolRegistryReader = () => readonly unknown[];
/**
 * Mutation epochs intentionally recognize only successful trusted `edit` and `write` results. They
 * do not attempt to detect arbitrary shell mutations such as `sed -i`; that is a known detection
 * limit rather than a reason to infer a mutation from command text.
 */

const TRUSTED_BUILTIN_TOOL_NAMES = new Set(['bash', 'powershell', 'edit', 'write', 'read']);

/**
 * The supported shell forms are exactly these simple commands (with optional surrounding or
 * repeated ASCII spaces/tabs):
 *
 * - tests: `pnpm test`, `pnpm run test`, `npm test`, `npm run test`, `yarn test`, `bun test`,
 *   `vitest`, `jest`, `pytest`, `python -m pytest`, `phpunit`, `vendor/bin/phpunit`,
 *   `php artisan test`, `go test`, `cargo test`, `dotnet test`
 * - lint: `pnpm lint`, `npm run lint`, `eslint`, `eslint .`, `oxlint`, `ruff check`
 * - typecheck: `pnpm typecheck`, `npm run typecheck`, `tsc`, `tsc --noEmit`, `vue-tsc`,
 *   `vue-tsc --noEmit`, `mypy`, `pyright`, `phpstan`, `psalm`
 * - build: `pnpm build`, `npm run build`, `cargo build`, `go build`, `mvn package`,
 *   `gradle build`, `./gradlew build`
 * - validation: `composer validate`, `git diff --check`
 * - repository-inspection: `git diff`, `git status`
 *
 * No flags, paths, wrappers, or additional arguments are supported. A command is rejected unless
 * the entire value matches one ASCII-token simple command. That anchored rule rejects newlines,
 * quotes, comments, assignments, pipelines, `;`, `&&`, `||`, redirection, substitutions, escaped
 * syntax, and every other character outside the simple-command token grammar. This intentionally
 * misses valid commands rather than treating ambiguous shell syntax as verification.
 */
const SUPPORTED_SIMPLE_COMMANDS = new Map<string, SupervisorVerificationKind>([
  ['pnpm test', 'test'],
  ['pnpm run test', 'test'],
  ['npm test', 'test'],
  ['npm run test', 'test'],
  ['yarn test', 'test'],
  ['bun test', 'test'],
  ['vitest', 'test'],
  ['jest', 'test'],
  ['pytest', 'test'],
  ['python -m pytest', 'test'],
  ['phpunit', 'test'],
  ['vendor/bin/phpunit', 'test'],
  ['php artisan test', 'test'],
  ['go test', 'test'],
  ['cargo test', 'test'],
  ['dotnet test', 'test'],
  ['pnpm lint', 'lint'],
  ['npm run lint', 'lint'],
  ['eslint', 'lint'],
  ['eslint .', 'lint'],
  ['oxlint', 'lint'],
  ['ruff check', 'lint'],
  ['pnpm typecheck', 'typecheck'],
  ['npm run typecheck', 'typecheck'],
  ['tsc', 'typecheck'],
  ['tsc --noEmit', 'typecheck'],
  ['vue-tsc', 'typecheck'],
  ['vue-tsc --noEmit', 'typecheck'],
  ['mypy', 'typecheck'],
  ['pyright', 'typecheck'],
  ['phpstan', 'typecheck'],
  ['psalm', 'typecheck'],
  ['pnpm build', 'build'],
  ['npm run build', 'build'],
  ['cargo build', 'build'],
  ['go build', 'build'],
  ['mvn package', 'build'],
  ['gradle build', 'build'],
  ['./gradlew build', 'build'],
  ['composer validate', 'validation'],
  ['git diff --check', 'validation'],
  ['git diff', 'repository-inspection'],
  ['git status', 'repository-inspection'],
]);

const SIMPLE_COMMAND_PATTERN = /^[ \t]*[A-Za-z0-9._/@:=+-]+(?:[ \t]+[A-Za-z0-9._/@:=+-]+)*[ \t]*$/;

/**
 * Returns true only when the effective registry entry for a protected name is a genuine builtin.
 * The last matching entry wins defensively, mirroring Pi's name-keyed effective registry.
 */
export function isSupervisorTrustedBuiltin(
  toolName: string,
  getAllTools: SupervisorToolRegistryReader | undefined,
): boolean {
  if (!TRUSTED_BUILTIN_TOOL_NAMES.has(toolName) || getAllTools === undefined) {
    return false;
  }

  try {
    const tools = getAllTools();
    if (!Array.isArray(tools)) {
      return false;
    }

    let source: unknown;
    for (const tool of tools) {
      if (typeof tool !== 'object' || tool === null || !('name' in tool)) {
        continue;
      }
      if (tool.name !== toolName) {
        continue;
      }
      const sourceInfo = 'sourceInfo' in tool ? tool.sourceInfo : undefined;
      source =
        typeof sourceInfo === 'object' && sourceInfo !== null && 'source' in sourceInfo
          ? sourceInfo.source
          : undefined;
    }
    return source === 'builtin';
  } catch {
    return false;
  }
}

/** Classify one transient builtin shell command, or return null when it is not unambiguous. */
export function classifySupervisorShellCommand(command: unknown): SupervisorVerificationKind | null {
  if (typeof command !== 'string' || !SIMPLE_COMMAND_PATTERN.test(command)) {
    return null;
  }

  const normalized = command.trim().replace(/[ \t]+/g, ' ');
  return SUPPORTED_SIMPLE_COMMANDS.get(normalized) ?? null;
}

/**
 * Compute the Root-local digest used for read-back matching. `resolve()` is the canonicalization
 * boundary; only its resulting path string is hashed, and the raw path is never returned.
 */
export function computeSupervisorPathDigest(pathValue: unknown): string | null {
  if (typeof pathValue !== 'string' || pathValue.length === 0) {
    return null;
  }

  try {
    return createHash('sha256').update(resolve(pathValue)).digest('hex');
  } catch {
    return null;
  }
}
