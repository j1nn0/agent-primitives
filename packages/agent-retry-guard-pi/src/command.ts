import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import { formatRetryPolicy, formatRetryState, formatRetryVerdict } from './display.js';
import {
  AUTO_RECORD_DISABLED_MESSAGE,
  AUTO_RECORD_ENABLED_MESSAGE,
  confirmationRequiredMessage,
  formatRetryError,
  NOTIFICATION_PREFIX,
  USAGE,
} from './messages.js';
import {
  addAttempt,
  clearState,
  isPositiveInteger,
  judgeState,
  setPolicy,
  type StateController,
} from './state.js';

export const COMMAND_NAME = 'agent-retry';

type AutoRecordController = {
  readonly replaceEnabled: (enabled: boolean) => void;
  readonly persist: (enabled: boolean) => void;
};

function notify(
  ctx: ExtensionCommandContext,
  message: string,
  type: 'info' | 'warning' | 'error' = 'info',
): void {
  ctx.ui.notify(message, type);
}

function isQuote(value: string | undefined): value is '"' | "'" {
  return value === '"' || value === "'";
}

function parseTokens(value: string): string[] | undefined {
  const tokens: string[] = [];
  let index = 0;

  while (index < value.length) {
    while (index < value.length && /\s/.test(value[index] ?? '')) {
      index += 1;
    }
    if (index >= value.length) {
      break;
    }

    const quote = value[index];
    let token = '';
    if (isQuote(quote)) {
      index += 1;
      let closed = false;
      while (index < value.length) {
        const character = value[index];
        if (character === quote) {
          index += 1;
          closed = true;
          break;
        }
        if (character === '\\' && index + 1 < value.length) {
          const escaped = value[index + 1];
          if (escaped === quote || escaped === '\\') {
            token += escaped;
          } else {
            token += character;
            token += escaped;
          }
          index += 2;
          continue;
        }
        token += character;
        index += 1;
      }
      if (!closed || (index < value.length && !/\s/.test(value[index] ?? ''))) {
        return undefined;
      }
    } else {
      while (index < value.length && !/\s/.test(value[index] ?? '')) {
        token += value[index] ?? '';
        index += 1;
      }
    }
    tokens.push(token);
  }

  return tokens;
}

function parsePositiveInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) {
    return undefined;
  }
  const number = Number(value);
  return isPositiveInteger(number) ? number : undefined;
}

function parsePolicyArguments(arguments_: readonly string[]):
  | { readonly clear: true }
  | { readonly clear: false; readonly policy: { readonly maxAttempts?: number; readonly maxStrategyAttempts?: number } }
  | undefined {
  if (arguments_.length === 1 && arguments_[0] === 'clear') {
    return { clear: true };
  }
  if (arguments_.length < 1 || arguments_.length > 2) {
    return undefined;
  }

  const maxAttempts = parsePositiveInteger(arguments_[0] ?? '');
  if (maxAttempts === undefined) {
    return undefined;
  }
  if (arguments_.length === 1) {
    return { clear: false, policy: { maxAttempts } };
  }

  const maxStrategyAttempts = parsePositiveInteger(arguments_[1] ?? '');
  if (maxStrategyAttempts === undefined) {
    return undefined;
  }
  return {
    clear: false,
    policy: { maxAttempts, maxStrategyAttempts },
  };
}

function showStatus(ctx: ExtensionCommandContext, controller: StateController): void {
  notify(ctx, formatRetryState(controller.getState()));
}

function showPolicy(ctx: ExtensionCommandContext, controller: StateController): void {
  notify(ctx, formatRetryPolicy(controller.getState().policy));
}

function recordAttempt(
  ctx: ExtensionCommandContext,
  controller: StateController,
  arguments_: readonly string[],
): void {
  if (arguments_.length < 1 || arguments_.length > 2) {
    notify(ctx, USAGE, 'warning');
    return;
  }

  const outcome = arguments_[0];
  const strategyId = arguments_.length === 2 ? arguments_[1] : undefined;
  const result = addAttempt(controller.getState(), outcome, strategyId);
  if (!result.changed) {
    notify(ctx, USAGE, 'warning');
    return;
  }

  controller.replaceState(result.state);
  controller.persist();
  const strategy = strategyId === undefined ? 'no strategy id' : 'strategy id recorded';
  notify(
    ctx,
    `${NOTIFICATION_PREFIX}recorded ${outcome} attempt (${strategy}); ${result.state.attempts.length} ${result.state.attempts.length === 1 ? 'attempt' : 'attempts'} in the current episode.`,
  );
}

function updatePolicy(
  ctx: ExtensionCommandContext,
  controller: StateController,
  policy: { readonly maxAttempts?: number; readonly maxStrategyAttempts?: number },
): void {
  const result = setPolicy(controller.getState(), policy);
  if (!result.changed) {
    notify(ctx, `${NOTIFICATION_PREFIX}policy unchanged.`);
    return;
  }

  controller.replaceState(result.state);
  controller.persist();
  notify(ctx, `${NOTIFICATION_PREFIX}policy updated. ${formatRetryPolicy(policy)}`);
}

function judgeCurrent(
  ctx: ExtensionCommandContext,
  controller: StateController,
): void {
  try {
    notify(ctx, formatRetryVerdict(judgeState(controller.getState())));
  } catch (error: unknown) {
    notify(ctx, formatRetryError(error), 'warning');
  }
}

function clearCurrent(
  ctx: ExtensionCommandContext,
  controller: StateController,
  confirmed: boolean,
): void {
  if (!confirmed) {
    notify(ctx, confirmationRequiredMessage(), 'warning');
    return;
  }

  controller.replaceState(clearState());
  controller.persist();
  notify(ctx, `${NOTIFICATION_PREFIX}cleared attempts and policy.`);
}

function configureAutoRecord(
  ctx: ExtensionCommandContext,
  controller: AutoRecordController,
  arguments_: readonly string[],
): void {
  const mode = arguments_[0];
  if (arguments_.length !== 1 || (mode !== 'on' && mode !== 'off')) {
    notify(ctx, USAGE, 'warning');
    return;
  }

  const enabled = mode === 'on';
  controller.replaceEnabled(enabled);
  controller.persist(enabled);
  notify(ctx, enabled ? AUTO_RECORD_ENABLED_MESSAGE : AUTO_RECORD_DISABLED_MESSAGE);
}

function handleCommand(
  args: string,
  ctx: ExtensionCommandContext,
  controller: StateController,
  autoRecordController: AutoRecordController,
): void {
  const tokens = parseTokens(args);
  if (tokens === undefined) {
    notify(ctx, USAGE, 'warning');
    return;
  }

  const subcommand = tokens[0];
  const arguments_ = tokens.slice(1);
  if (subcommand === undefined) {
    showStatus(ctx, controller);
    return;
  }

  switch (subcommand) {
    case 'status':
      if (arguments_.length !== 0) {
        notify(ctx, USAGE, 'warning');
        return;
      }
      showStatus(ctx, controller);
      return;
    case 'add':
      recordAttempt(ctx, controller, arguments_);
      return;
    case 'policy': {
      if (arguments_.length === 0) {
        showPolicy(ctx, controller);
        return;
      }
      const parsed = parsePolicyArguments(arguments_);
      if (parsed === undefined) {
        notify(ctx, USAGE, 'warning');
        return;
      }
      if (parsed.clear) {
        updatePolicy(ctx, controller, {});
      } else {
        updatePolicy(ctx, controller, parsed.policy);
      }
      return;
    }
    case 'judge':
      if (arguments_.length !== 0) {
        notify(ctx, USAGE, 'warning');
        return;
      }
      judgeCurrent(ctx, controller);
      return;
    case 'clear':
      clearCurrent(
        ctx,
        controller,
        arguments_.length === 1 && arguments_[0] === '--yes',
      );
      return;
    case 'auto-record':
      configureAutoRecord(ctx, autoRecordController, arguments_);
      return;
    default:
      notify(ctx, USAGE, 'warning');
  }
}

export function registerAgentRetryCommand(
  pi: ExtensionAPI,
  controller: StateController,
  autoRecordController: AutoRecordController,
): void {
  pi.registerCommand(COMMAND_NAME, {
    description: 'Record and judge caller-declared retry attempts.',
    handler: async (args, ctx): Promise<void> => {
      handleCommand(args, ctx, controller, autoRecordController);
    },
  });
}

