import { judgeBudget } from '@j1nn0/agent-budget';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { formatStateSummary, judgeBudgetText } from './display.js';
import {
  clearConfirmationMessage,
  clearedBudgetsMessage,
  createdBudgetMessage,
  formatBudgetError,
  invalidBudgetInputMessage,
  nothingToClearMessage,
  removedBudgetMessage,
  replacedBudgetMessage,
  unchangedBudgetMessage,
  unknownBudgetMessage,
  USAGE,
} from './messages.js';
import {
  clearAll,
  isValidIdentifier,
  removeBudget,
  type PersistedRecord,
  type StateController,
  upsertBudget,
} from './state.js';

export const COMMAND_NAME = 'agent-budget';

function notify(
  ctx: ExtensionCommandContext,
  message: string,
  type: 'info' | 'warning' | 'error' = 'info',
): void {
  ctx.ui.notify(message, type);
}

function parseSingleArgument(value: string): string | undefined {
  const trimmed = value.trim();
  return isValidIdentifier(trimmed) ? trimmed : undefined;
}

function showStatus(ctx: ExtensionCommandContext, controller: StateController): void {
  notify(ctx, formatStateSummary(controller.getState()));
}

function setCurrent(ctx: ExtensionCommandContext, controller: StateController, value: string): void {
  const candidate = parseSetArguments(value);
  if (candidate === undefined) {
    notify(ctx, invalidBudgetInputMessage(), 'warning');
    return;
  }

  const result = upsertBudget(controller.getState(), candidate);
  if (!result.changed) {
    notify(
      ctx,
      result.reason === 'unchanged'
        ? unchangedBudgetMessage(candidate.id)
        : invalidBudgetInputMessage(),
      'warning',
    );
    return;
  }

  controller.replaceState(result.state);
  controller.persist();
  notify(
    ctx,
    result.reason === 'created'
      ? createdBudgetMessage(candidate.id)
      : replacedBudgetMessage(candidate.id),
  );
}

function removeCurrent(ctx: ExtensionCommandContext, controller: StateController, value: string): void {
  const id = parseSingleArgument(value);
  if (id === undefined) {
    notify(ctx, USAGE, 'warning');
    return;
  }

  const result = removeBudget(controller.getState(), id);
  if (!result.changed) {
    notify(ctx, unknownBudgetMessage(id), 'warning');
    return;
  }

  controller.replaceState(result.state);
  controller.persist();
  notify(ctx, removedBudgetMessage(id));
}

function judgeCurrent(ctx: ExtensionCommandContext, controller: StateController, value: string): void {
  if (value.trim() !== '') {
    notify(ctx, USAGE, 'warning');
    return;
  }
  notify(ctx, judgeBudgetText(controller.getState()));
}

function clearCurrent(ctx: ExtensionCommandContext, controller: StateController, value: string): void {
  const state = controller.getState();
  if (state.budgets.length === 0) {
    notify(ctx, nothingToClearMessage());
    return;
  }

  if (value.trim() !== '--yes') {
    notify(ctx, clearConfirmationMessage(state.budgets.length), 'warning');
    return;
  }

  const result = clearAll(state);
  if (!result.changed) {
    notify(ctx, nothingToClearMessage());
    return;
  }

  controller.replaceState(result.state);
  controller.persist();
  notify(ctx, clearedBudgetsMessage(state.budgets.length));
}

function parseSetArguments(value: string): PersistedRecord | undefined {
  const trimmed = value.trim();
  const tokens = trimmed === '' ? [] : trimmed.split(/\s+/);
  const id = tokens.shift();
  if (id === undefined || !isValidIdentifier(id)) {
    return undefined;
  }

  let consumedRaw: string | undefined;
  let limitRaw: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      return undefined;
    }

    let name: 'consumed' | 'limit' | undefined;
    let raw: string | undefined;
    if (token === '--consumed') {
      name = 'consumed';
      index += 1;
      raw = tokens[index];
    } else if (token.startsWith('--consumed=')) {
      name = 'consumed';
      raw = token.slice('--consumed='.length);
    } else if (token === '--limit') {
      name = 'limit';
      index += 1;
      raw = tokens[index];
    } else if (token.startsWith('--limit=')) {
      name = 'limit';
      raw = token.slice('--limit='.length);
    } else {
      return undefined;
    }

    if (name === undefined || raw === undefined || raw.length === 0 || raw.startsWith('--')) {
      return undefined;
    }
    if (name === 'consumed') {
      if (consumedRaw !== undefined) {
        return undefined;
      }
      consumedRaw = raw;
    } else {
      if (limitRaw !== undefined) {
        return undefined;
      }
      limitRaw = raw;
    }
  }

  if (consumedRaw === undefined || limitRaw === undefined) {
    return undefined;
  }

  const consumed = Number(consumedRaw);
  const limit = Number(limitRaw);
  try {
    judgeBudget({ consumed, limit });
  } catch {
    return undefined;
  }
  return { id, consumed, limit };
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
    case 'set':
      setCurrent(ctx, controller, rest);
      return;
    case 'remove':
      removeCurrent(ctx, controller, rest);
      return;
    case 'judge':
      judgeCurrent(ctx, controller, rest);
      return;
    case 'clear':
      clearCurrent(ctx, controller, rest);
      return;
    default:
      notify(ctx, USAGE, 'warning');
  }
}

export function registerAgentBudgetCommand(pi: ExtensionAPI, controller: StateController): void {
  pi.registerCommand(COMMAND_NAME, {
    description: 'Store and judge caller-declared budget records.',
    handler: async (args, ctx): Promise<void> => {
      try {
        handleCommand(args, ctx, controller);
      } catch (error: unknown) {
        notify(ctx, formatBudgetError(error), 'warning');
      }
    },
  });
}
