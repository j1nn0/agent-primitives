import {
  restoreAgentState,
  summarizeAgentState,
  type WorkItemStatus,
} from '@j1nn0/agent-state';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import { formatAgentState } from './display.js';
import { formatStateError } from './messages.js';
import {
  createEmptyState,
  type StateController,
} from './state.js';

export const COMMAND_NAME = 'agent-state';

export const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  'open',
  'in_progress',
  'blocked',
  'done',
];

const USAGE =
  'Usage: /agent-state status | objective <text...> | add <id> <content...> | set <id> <open|in_progress|blocked|done> | remove <id> | decide <id> <content...> | clear --yes';

interface IdAndContent {
  readonly id: string;
  readonly content: string;
}

interface StatusArguments {
  readonly id: string;
  readonly status: string;
}

function notify(
  ctx: ExtensionCommandContext,
  message: string,
  type: 'info' | 'warning' | 'error' = 'info',
): void {
  ctx.ui.notify(message, type);
}

function isWorkItemStatus(value: string): value is WorkItemStatus {
  return WORK_ITEM_STATUSES.includes(value as WorkItemStatus);
}

function parseIdAndContent(value: string): IdAndContent | undefined {
  const match = /^(\S+)\s+([\s\S]+)$/.exec(value.trimStart());
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return undefined;
  }
  return { id: match[1], content: match[2] };
}

function parseStatusArguments(value: string): StatusArguments | undefined {
  const match = /^(\S+)\s+(\S+)$/.exec(value.trim());
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return undefined;
  }
  return { id: match[1], status: match[2] };
}

function parseSingleArgument(value: string): string | undefined {
  const trimmed = value.trim();
  return /^\S+$/.test(trimmed) ? trimmed : undefined;
}

function invalidStatusMessage(status: string): string {
  return `Agent State: invalid status "${status}"; expected ${WORK_ITEM_STATUSES.join(', ')}.`;
}

function showStatus(ctx: ExtensionCommandContext, controller: StateController): void {
  notify(ctx, formatAgentState(controller.getState()));
}

function setObjective(
  ctx: ExtensionCommandContext,
  controller: StateController,
  value: string,
): void {
  const objective = value.trim();
  if (objective.length === 0) {
    notify(ctx, USAGE, 'warning');
    return;
  }

  const current = controller.getState();
  try {
    const next = restoreAgentState({
      ...current.snapshot(),
      objective,
    });
    if (current.snapshot().objective === objective) {
      notify(ctx, `Agent State: objective is already set to "${objective}".`);
      return;
    }
    controller.replaceState(next);
    controller.persist();
    notify(ctx, 'Agent State: objective updated.');
  } catch (error: unknown) {
    notify(ctx, formatStateError(error), 'warning');
  }
}

function addWorkItem(
  ctx: ExtensionCommandContext,
  controller: StateController,
  value: string,
): void {
  const parsed = parseIdAndContent(value);
  if (parsed === undefined) {
    notify(ctx, USAGE, 'warning');
    return;
  }

  try {
    controller.getState().addWorkItem(parsed);
    controller.persist();
    notify(ctx, `Agent State: added work item "${parsed.id}".`);
  } catch (error: unknown) {
    notify(ctx, formatStateError(error), 'warning');
  }
}

function setWorkItemStatus(
  ctx: ExtensionCommandContext,
  controller: StateController,
  value: string,
): void {
  const parsed = parseStatusArguments(value);
  if (parsed === undefined) {
    notify(ctx, USAGE, 'warning');
    return;
  }
  if (!isWorkItemStatus(parsed.status)) {
    notify(ctx, invalidStatusMessage(parsed.status), 'warning');
    return;
  }

  const state = controller.getState();
  try {
    const current = state.getWorkItem(parsed.id);
    const updated = state.setWorkItemStatus(parsed.id, parsed.status);
    if (current?.status !== updated.status) {
      controller.persist();
    }
    notify(ctx, `Agent State: work item "${parsed.id}" is now ${parsed.status}.`);
  } catch (error: unknown) {
    notify(ctx, formatStateError(error), 'warning');
  }
}

function removeWorkItem(
  ctx: ExtensionCommandContext,
  controller: StateController,
  value: string,
): void {
  const id = parseSingleArgument(value);
  if (id === undefined) {
    notify(ctx, USAGE, 'warning');
    return;
  }

  if (!controller.getState().removeWorkItem(id)) {
    notify(ctx, `Agent State: unknown work item id "${id}".`, 'warning');
    return;
  }
  controller.persist();
  notify(ctx, `Agent State: removed work item "${id}".`);
}

function addDecision(
  ctx: ExtensionCommandContext,
  controller: StateController,
  value: string,
): void {
  const parsed = parseIdAndContent(value);
  if (parsed === undefined) {
    notify(ctx, USAGE, 'warning');
    return;
  }

  try {
    controller.getState().addDecision(parsed);
    controller.persist();
    notify(ctx, `Agent State: added decision "${parsed.id}".`);
  } catch (error: unknown) {
    notify(ctx, formatStateError(error), 'warning');
  }
}

function clearState(
  ctx: ExtensionCommandContext,
  controller: StateController,
  value: string,
): void {
  const snapshot = controller.getState().snapshot();
  const summary = summarizeAgentState(snapshot);
  const decisionCount = snapshot.decisions.length;
  const hasObjective = snapshot.objective !== undefined;

  if (value.trim() !== '--yes') {
    const objectiveText = hasObjective ? 'the objective, ' : '';
    notify(
      ctx,
      `Agent State: clear would remove ${objectiveText}${summary.total} ${summary.total === 1 ? 'work item' : 'work items'} and ${decisionCount} ${decisionCount === 1 ? 'decision' : 'decisions'}. Run /agent-state clear --yes to confirm.`,
      'warning',
    );
    return;
  }

  if (!hasObjective && summary.total === 0 && decisionCount === 0) {
    notify(ctx, 'Agent State: state is already empty.');
    return;
  }

  controller.replaceState(createEmptyState());
  controller.persist();
  notify(ctx, 'Agent State: cleared.');
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
    case 'objective':
      setObjective(ctx, controller, value);
      return;
    case 'add':
      addWorkItem(ctx, controller, value);
      return;
    case 'set':
      setWorkItemStatus(ctx, controller, value);
      return;
    case 'remove':
      removeWorkItem(ctx, controller, value);
      return;
    case 'decide':
      addDecision(ctx, controller, value);
      return;
    case 'clear':
      clearState(ctx, controller, value);
      return;
    default:
      notify(ctx, USAGE, 'warning');
  }
}

export function registerAgentStateCommand(
  pi: ExtensionAPI,
  controller: StateController,
): void {
  pi.registerCommand(COMMAND_NAME, {
    description: 'Record and inspect caller-declared Agent State.',
    handler: async (args, ctx): Promise<void> => {
      handleCommand(args, ctx, controller);
    },
  });
}
