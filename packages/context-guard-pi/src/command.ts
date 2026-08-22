import { ContextGuardError } from '@j1nn0/agent-context-guard';
import type {
  ContextGuard,
  ContextItemKind,
} from '@j1nn0/agent-context-guard';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import type {
  LastVerification,
  RecoveryMode,
  RuntimeState,
} from './types.js';

const USAGE =
  'Usage: /context-guard add <id> <kind> [--critical] <content...> | list | remove <id> | clear [--yes] | status | recovery [off|critical]';
const KINDS: readonly ContextItemKind[] = [
  'goal',
  'constraint',
  'requirement',
  'decision',
  'fact',
];

interface CommandController {
  readonly getState: () => RuntimeState;
  readonly setRecoveryMode: (mode: RecoveryMode) => void;
  readonly clearPendingSnapshot: () => void;
  readonly persist: () => void;
  readonly getLastVerification: () => LastVerification | undefined;
  readonly getLastUnverifiableCompactionId: () => string | undefined;
}

interface AddArguments {
  readonly id: string;
  readonly kind: ContextItemKind;
  readonly content: string;
  readonly critical: boolean;
}

function isContextItemKind(value: string): value is ContextItemKind {
  return KINDS.includes(value as ContextItemKind);
}

function notify(
  ctx: ExtensionCommandContext,
  message: string,
  type: 'info' | 'warning' | 'error' = 'info',
): void {
  ctx.ui.notify(message, type);
}

function parseAddArguments(value: string): AddArguments | undefined {
  const match = /^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(value);
  if (match === null) {
    return undefined;
  }

  const [, id, kindValue, capturedContent] = match;
  if (id === undefined || kindValue === undefined || !isContextItemKind(kindValue)) {
    return undefined;
  }

  let content = capturedContent ?? '';
  let critical = false;
  while (content === '--critical' || /^--critical[ \t]/.test(content)) {
    critical = true;
    content = content.slice('--critical'.length);
    content = content.replace(/^[ \t]+/, '');
  }

  content = content.replace(/ $/, '');
  if (content.length === 0) {
    return undefined;
  }

  return { id, kind: kindValue, content, critical };
}

function parseSingleArgument(value: string): string | undefined {
  const trimmed = value.trim();
  return /^\S+$/.test(trimmed) ? trimmed : undefined;
}

function verificationSummary(
  last: LastVerification | undefined,
  lastUnverifiableCompactionId: string | undefined,
): string {
  if (last === undefined) {
    return lastUnverifiableCompactionId === undefined
      ? 'Last verification: none.'
      : `Last verification: compaction '${lastUnverifiableCompactionId}' was unverifiable.`;
  }

  const { report } = last;
  const criticalIds =
    report.criticalFailures.length === 0
      ? 'none'
      : report.criticalFailures.join(', ');
  return [
    `Last verification: ${report.preserved.length} preserved, ${report.changed.length} changed, ${report.lost.length} lost, ${report.unknown.length} unknown`,
    `critical failure ids: ${criticalIds}.`,
  ].join('; ');
}

function listItems(ctx: ExtensionCommandContext, guard: ContextGuard): void {
  const items = guard.list();
  if (items.length === 0) {
    notify(ctx, 'Context Guard: no protected items.');
    return;
  }

  const lines = items.map((item) => {
    const critical = item.critical ? ', critical' : '';
    return `${item.id} [${item.kind}${critical}]: ${item.content}`;
  });
  notify(ctx, lines.join('\n'));
}

function showStatus(
  ctx: ExtensionCommandContext,
  controller: CommandController,
): void {
  const state = controller.getState();
  const criticalCount = state.guard.list().filter((item) => item.critical).length;
  const status = [
    `Context Guard: ${state.guard.size()} items, ${criticalCount} critical, recovery ${state.recovery}, degraded ${state.degraded ? 'yes' : 'no'}.`,
    verificationSummary(
      controller.getLastVerification(),
      controller.getLastUnverifiableCompactionId(),
    ),
  ].join(' ');
  notify(ctx, status);
}

function addItem(
  ctx: ExtensionCommandContext,
  controller: CommandController,
  value: string,
): void {
  const parsed = parseAddArguments(value);
  if (parsed === undefined) {
    notify(ctx, USAGE, 'warning');
    return;
  }

  try {
    controller.getState().guard.add(parsed);
  } catch (error: unknown) {
    if (
      error instanceof ContextGuardError &&
      error.code === 'duplicate_item_id'
    ) {
      notify(ctx, `Context Guard: item id '${parsed.id}' already exists.`, 'warning');
      return;
    }
    notify(ctx, 'Context Guard: invalid protected item.', 'error');
    return;
  }

  controller.clearPendingSnapshot();
  controller.persist();
  notify(ctx, `Context Guard: added '${parsed.id}'.`);
}

function removeItem(
  ctx: ExtensionCommandContext,
  controller: CommandController,
  value: string,
): void {
  const id = parseSingleArgument(value);
  if (id === undefined) {
    notify(ctx, 'Usage: /context-guard remove <id>', 'warning');
    return;
  }

  if (!controller.getState().guard.remove(id)) {
    notify(ctx, `Context Guard: item '${id}' was not found.`, 'warning');
    return;
  }

  controller.clearPendingSnapshot();
  controller.persist();
  notify(ctx, `Context Guard: removed '${id}'.`);
}

function clearItems(
  ctx: ExtensionCommandContext,
  controller: CommandController,
  value: string,
): void {
  const state = controller.getState();
  const count = state.guard.size();
  if (value.trim() !== '--yes') {
    notify(
      ctx,
      `Context Guard: ${count} protected item${count === 1 ? '' : 's'} would be deleted. Run /context-guard clear --yes to confirm.`,
      'warning',
    );
    return;
  }

  controller.clearPendingSnapshot();
  state.guard.clear();
  controller.persist();
  notify(ctx, `Context Guard: cleared ${count} protected item${count === 1 ? '' : 's'}.`);
}

function changeRecovery(
  ctx: ExtensionCommandContext,
  controller: CommandController,
  value: string,
): void {
  const mode = value.trim();
  if (mode !== 'off' && mode !== 'critical') {
    notify(ctx, 'Usage: /context-guard recovery [off|critical]', 'warning');
    return;
  }

  const state = controller.getState();
  if (state.recovery === mode) {
    notify(ctx, `Context Guard: recovery is already '${mode}'.`);
    return;
  }

  controller.clearPendingSnapshot();
  controller.setRecoveryMode(mode);
  controller.persist();
  notify(ctx, `Context Guard: recovery set to '${mode}'.`);
}

async function handleCommand(
  args: string,
  ctx: ExtensionCommandContext,
  controller: CommandController,
): Promise<void> {
  const trimmed = args.trimStart();
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (match === null || match[1] === undefined) {
    notify(ctx, USAGE, 'warning');
    return;
  }

  const subcommand = match[1];
  const value = match[2] ?? '';
  switch (subcommand) {
    case 'add':
      addItem(ctx, controller, value);
      return;
    case 'list':
      if (value.trim().length !== 0) {
        notify(ctx, 'Usage: /context-guard list', 'warning');
        return;
      }
      listItems(ctx, controller.getState().guard);
      return;
    case 'remove':
      removeItem(ctx, controller, value);
      return;
    case 'clear':
      clearItems(ctx, controller, value);
      return;
    case 'status':
      if (value.trim().length !== 0) {
        notify(ctx, 'Usage: /context-guard status', 'warning');
        return;
      }
      showStatus(ctx, controller);
      return;
    case 'recovery':
      changeRecovery(ctx, controller, value);
      return;
    default:
      notify(ctx, USAGE, 'warning');
  }
}

export function registerContextGuardCommand(
  pi: ExtensionAPI,
  controller: CommandController,
): void {
  pi.registerCommand('context-guard', {
    description: 'Protect context items across Pi compaction.',
    handler: async (args, ctx): Promise<void> => {
      await handleCommand(args, ctx, controller);
    },
  });
}
