import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import { formatProgressState, formatProgressVerdict } from './display.js';
import {
  duplicateMilestoneMessage,
  formatProgressError,
  invalidMilestoneMessage,
  NOTIFICATION_PREFIX,
  unknownMilestoneMessage,
  USAGE,
} from './messages.js';
import {
  addMilestone,
  createEmptyState,
  isFreshState,
  judgeState,
  type StateController,
  withdrawMilestone,
} from './state.js';

export const COMMAND_NAME = 'agent-progress';

function notify(
  ctx: ExtensionCommandContext,
  message: string,
  type: 'info' | 'warning' | 'error' = 'info',
): void {
  ctx.ui.notify(message, type);
}

function parseSingleArgument(value: string): string | undefined {
  const trimmed = value.trim();
  return /^\S+$/.test(trimmed) ? trimmed : undefined;
}

function showStatus(
  ctx: ExtensionCommandContext,
  controller: StateController,
): void {
  notify(ctx, formatProgressState(controller.getState()));
}

function addDeclaredMilestone(
  ctx: ExtensionCommandContext,
  controller: StateController,
  value: string,
): void {
  const milestone = parseSingleArgument(value);
  if (milestone === undefined) {
    notify(ctx, USAGE, 'warning');
    return;
  }

  const result = addMilestone(controller.getState(), milestone);
  if (!result.changed) {
    notify(
      ctx,
      result.reason === 'invalid'
        ? invalidMilestoneMessage()
        : duplicateMilestoneMessage(milestone),
      'warning',
    );
    return;
  }

  controller.replaceState(result.state);
  controller.persist();
  notify(ctx, `${NOTIFICATION_PREFIX}added milestone "${milestone}".`);
}

function withdrawDeclaredMilestone(
  ctx: ExtensionCommandContext,
  controller: StateController,
  value: string,
): void {
  const milestone = parseSingleArgument(value);
  if (milestone === undefined) {
    notify(ctx, USAGE, 'warning');
    return;
  }

  const result = withdrawMilestone(controller.getState(), milestone);
  if (!result.changed) {
    notify(
      ctx,
      result.reason === 'invalid'
        ? invalidMilestoneMessage()
        : unknownMilestoneMessage(milestone),
      'warning',
    );
    return;
  }

  controller.replaceState(result.state);
  controller.persist();
  notify(ctx, `${NOTIFICATION_PREFIX}withdrew milestone "${milestone}".`);
}

function judgeDeclaredProgress(
  ctx: ExtensionCommandContext,
  controller: StateController,
): void {
  try {
    const result = judgeState(controller.getState());
    if (result.changed) {
      controller.replaceState(result.state);
      controller.persist();
    }
    notify(ctx, formatProgressVerdict(result.verdict));
  } catch (error: unknown) {
    notify(ctx, formatProgressError(error), 'warning');
  }
}

function clearState(
  ctx: ExtensionCommandContext,
  controller: StateController,
  value: string,
): void {
  if (value.trim() !== '--yes') {
    const state = controller.getState();
    notify(
      ctx,
      `${NOTIFICATION_PREFIX}clear would remove ${state.currentMilestones.length} declared ${state.currentMilestones.length === 1 ? 'milestone' : 'milestones'} and ${state.recordedMilestones.length} recorded ${state.recordedMilestones.length === 1 ? 'milestone' : 'milestones'}. Run /agent-progress clear --yes to confirm.`,
      'warning',
    );
    return;
  }

  if (isFreshState(controller.getState())) {
    notify(ctx, `${NOTIFICATION_PREFIX}state is already empty.`);
    return;
  }

  controller.replaceState(createEmptyState());
  controller.persist();
  notify(ctx, `${NOTIFICATION_PREFIX}cleared.`);
}

function handleCommand(
  args: string,
  ctx: ExtensionCommandContext,
  controller: StateController,
): void {
  const trimmed = args.trimStart();
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (match === null || match[1] === undefined) {
    notify(ctx, USAGE, 'warning');
    return;
  }

  const subcommand = match[1];
  const value = match[2] ?? '';
  switch (subcommand) {
    case 'status':
      if (value.trim().length !== 0) {
        notify(ctx, USAGE, 'warning');
        return;
      }
      showStatus(ctx, controller);
      return;
    case 'add':
      addDeclaredMilestone(ctx, controller, value);
      return;
    case 'withdraw':
      withdrawDeclaredMilestone(ctx, controller, value);
      return;
    case 'judge':
      if (value.trim().length !== 0) {
        notify(ctx, USAGE, 'warning');
        return;
      }
      judgeDeclaredProgress(ctx, controller);
      return;
    case 'clear':
      clearState(ctx, controller, value);
      return;
    default:
      notify(ctx, USAGE, 'warning');
  }
}

export function registerAgentProgressCommand(
  pi: ExtensionAPI,
  controller: StateController,
): void {
  pi.registerCommand(COMMAND_NAME, {
    description: 'Record and judge caller-declared progress.',
    handler: async (args, ctx): Promise<void> => {
      handleCommand(args, ctx, controller);
    },
  });
}
