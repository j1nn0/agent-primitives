import { judgeToolPolicy } from '@j1nn0/agent-tool-policy';
import type { ToolPolicy } from '@j1nn0/agent-tool-policy';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import {
  JUDGMENT_FAILED_REASON,
  USAGE,
  alreadyDisabledMessage,
  clearConfirmationMessage,
  commandFailureMessage,
  corruptModeMessage,
  disabledModeMessage,
  disabledPolicyMessage,
  invalidPolicyJsonMessage,
  invalidPolicyMessage,
  judgePolicyMessage,
  setPolicyMessage,
  unconfiguredModeMessage,
} from './messages.js';
import {
  createDisabledState,
  createEnforcingState,
  isValidPolicy,
  isValidToolName,
  type PolicyMode,
  type StateController,
} from './state.js';

export const COMMAND_NAME = 'agent-tool-policy';

function notify(
  ctx: ExtensionCommandContext,
  message: string,
  type: 'info' | 'warning' | 'error' = 'info',
): void {
  ctx.ui.notify(message, type);
}

type PolicyParseResult =
  | { readonly kind: 'json_error' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'valid'; readonly policy: ToolPolicy };

function parsePolicyJson(value: string): PolicyParseResult {
  let candidate: unknown;

  try {
    candidate = JSON.parse(value.trim());
  } catch {
    return { kind: 'json_error' };
  }

  if (!isValidPolicy(candidate)) {
    return { kind: 'invalid' };
  }

  return { kind: 'valid', policy: candidate };
}

function showStatus(ctx: ExtensionCommandContext, controller: StateController): void {
  const state = controller.getState();
  notify(ctx, formatStatus(state));
}

function formatStatus(state: PolicyMode): string {
  switch (state.kind) {
    case 'unconfigured':
      return `${unconfiguredModeMessage()} /agent-tool-policy clear --yes writes an explicit DISABLED marker (policy: null); it does not delete history.`;
    case 'disabled':
      return `${disabledModeMessage()} /agent-tool-policy clear --yes writes an explicit DISABLED marker (policy: null); it does not delete history.`;
    case 'corrupt':
      return `${corruptModeMessage()} /agent-tool-policy clear --yes writes an explicit DISABLED marker (policy: null); it does not delete history.`;
    case 'enforcing':
      return `${
        'Agent Tool Policy: mode is enforcing.'
      } policy=${JSON.stringify(state.policy)}. /agent-tool-policy clear --yes writes an explicit DISABLED marker (policy: null); it does not delete history.`;
  }
}

function setCurrent(
  ctx: ExtensionCommandContext,
  controller: StateController,
  value: string,
): void {
  const result = parsePolicyJson(value);
  if (result.kind === 'json_error') {
    notify(ctx, invalidPolicyJsonMessage(), 'warning');
    return;
  }
  if (result.kind === 'invalid') {
    notify(ctx, invalidPolicyMessage(), 'warning');
    return;
  }

  controller.replaceState(createEnforcingState(result.policy));
  controller.persist();
  notify(ctx, setPolicyMessage());
}

function judgeCurrent(
  ctx: ExtensionCommandContext,
  controller: StateController,
  value: string,
): void {
  const toolName = value.trim();
  if (!isValidToolName(toolName)) {
    notify(ctx, USAGE, 'warning');
    return;
  }

  const state = controller.getState();
  switch (state.kind) {
    case 'unconfigured':
      notify(ctx, unconfiguredModeMessage(), 'warning');
      return;
    case 'disabled':
      notify(ctx, disabledModeMessage());
      return;
    case 'corrupt':
      notify(ctx, corruptModeMessage(), 'warning');
      return;
    case 'enforcing':
      try {
        notify(ctx, judgePolicyMessage(toolName, judgeToolPolicy({ tool: toolName, policy: state.policy })));
      } catch {
        notify(ctx, `${JUDGMENT_FAILED_REASON} State was unchanged.`, 'warning');
      }
  }
}

function clearCurrent(
  ctx: ExtensionCommandContext,
  controller: StateController,
  value: string,
): void {
  const argument = value.trim();
  if (argument !== '' && argument !== '--yes') {
    notify(ctx, USAGE, 'warning');
    return;
  }

  if (argument !== '--yes') {
    notify(ctx, clearConfirmationMessage(), 'warning');
    return;
  }

  if (controller.getState().kind === 'disabled') {
    notify(ctx, alreadyDisabledMessage());
    return;
  }

  controller.replaceState(createDisabledState());
  controller.persist();
  notify(ctx, disabledPolicyMessage());
}

function handleCommand(
  args: string,
  ctx: ExtensionCommandContext,
  controller: StateController,
): void {
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

export function registerAgentToolPolicyCommand(
  pi: ExtensionAPI,
  controller: StateController,
): void {
  pi.registerCommand(COMMAND_NAME, {
    description: 'Configure and inspect the caller-declared tool policy.',
    handler: async (args, ctx): Promise<void> => {
      try {
        handleCommand(args, ctx, controller);
      } catch {
        notify(ctx, commandFailureMessage(), 'warning');
      }
    },
  });
}
