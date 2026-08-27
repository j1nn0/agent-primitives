import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { formatHandoffPacket, formatHandoffState } from './display.js';
import {
  alreadyClearMessage,
  formatHandoffError,
  invalidMutationMessage,
  NOTIFICATION_PREFIX,
  unknownPacketMessage,
  USAGE,
} from './messages.js';
import { clearState, removePacket, type StateController } from './state.js';

export const COMMAND_NAME = 'agent-handoff';

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

function showStatus(ctx: ExtensionCommandContext, controller: StateController): void {
  notify(ctx, formatHandoffState(controller.getState()));
}

function showPacket(
  ctx: ExtensionCommandContext,
  controller: StateController,
  value: string,
): void {
  const id = parseSingleArgument(value);
  if (id === undefined) {
    notify(ctx, USAGE, 'warning');
    return;
  }

  const packet = controller.getState().packets.find((p) => p.id === id);
  if (packet === undefined) {
    notify(ctx, unknownPacketMessage(id), 'warning');
    return;
  }

  notify(ctx, formatHandoffPacket(packet));
}

function removeCurrent(
  ctx: ExtensionCommandContext,
  controller: StateController,
  value: string,
): void {
  const id = parseSingleArgument(value);
  if (id === undefined) {
    notify(ctx, USAGE, 'warning');
    return;
  }

  const result = removePacket(controller.getState(), id);
  if (!result.changed) {
    notify(
      ctx,
      result.reason === 'not_found' ? unknownPacketMessage(id) : invalidMutationMessage(),
      'warning',
    );
    return;
  }

  controller.replaceState(result.state);
  controller.persist();
  notify(ctx, `${NOTIFICATION_PREFIX}removed packet "${id}".`);
}

function clearCurrent(ctx: ExtensionCommandContext, controller: StateController, value: string): void {
  if (value.trim() !== '--yes') {
    const state = controller.getState();
    if (state.packets.length === 0) {
      notify(ctx, alreadyClearMessage());
      return;
    }
    notify(
      ctx,
      `${NOTIFICATION_PREFIX}clear would remove ${state.packets.length} ${state.packets.length === 1 ? 'packet' : 'packets'}. Run /agent-handoff clear --yes to confirm.`,
      'warning',
    );
    return;
  }

  const result = clearState(controller.getState());
  if (!result.changed) {
    notify(ctx, alreadyClearMessage());
    return;
  }

  controller.replaceState(result.state);
  controller.persist();
  notify(ctx, `${NOTIFICATION_PREFIX}cleared.`);
}

function handleCommand(args: string, ctx: ExtensionCommandContext, controller: StateController): void {
  const raw = args.trim();
  if (raw === '') {
    showStatus(ctx, controller);
    return;
  }

  const trimmed = args.trimStart();
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (match === null || match[1] === undefined) {
    notify(ctx, USAGE, 'warning');
    return;
  }

  const verb = match[1];
  const rest = match[2] ?? '';

  switch (verb) {
    case 'status':
      if (rest.trim() !== '') {
        notify(ctx, USAGE, 'warning');
        return;
      }
      showStatus(ctx, controller);
      return;
    case 'show':
      showPacket(ctx, controller, rest);
      return;
    case 'remove':
      removeCurrent(ctx, controller, rest);
      return;
    case 'clear':
      clearCurrent(ctx, controller, rest);
      return;
    default:
      notify(ctx, USAGE, 'warning');
  }
}

export function registerAgentHandoffCommand(pi: ExtensionAPI, controller: StateController): void {
  pi.registerCommand(COMMAND_NAME, {
    description: 'Persist and inspect caller-declared handoff packets.',
    handler: async (args, ctx): Promise<void> => {
      try {
        handleCommand(args, ctx, controller);
      } catch (error: unknown) {
        notify(ctx, formatHandoffError(error), 'warning');
      }
    },
  });
}
