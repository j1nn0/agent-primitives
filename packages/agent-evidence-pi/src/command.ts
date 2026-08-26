import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import type { ClaimRequirement } from '@j1nn0/agent-evidence';
import { formatEvidenceState, formatEvidenceVerdict } from './display.js';
import {
  alreadyClearMessage,
  confirmationRequiredMessage,
  formatEvidenceError,
  invalidMutationMessage,
  NOTIFICATION_PREFIX,
  unknownClaimMessage,
  unknownEvidenceMessage,
  USAGE,
} from './messages.js';
import {
  addClaim,
  addEvidence,
  clearState,
  isEvidenceOutcome,
  isValidIdentifier,
  judgeState,
  removeClaim,
  removeEvidence,
  replaceEvidence,
  type StateController,
} from './state.js';

export const COMMAND_NAME = 'agent-evidence';

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

function isCliValue(value: string | undefined): value is string {
  return (
    value !== undefined &&
    isValidIdentifier(value)
  );
}

function isSingleTokenSubject(value: string | undefined): value is string {
  return isCliValue(value) && !/\s/.test(value);
}

type ParsedClaimAdd = {
  readonly id: string;
  readonly requires: readonly ClaimRequirement[];
};

function parseClaimAddArguments(
  arguments_: readonly string[],
): ParsedClaimAdd | undefined {
  const id = arguments_[0];
  if (!isCliValue(id) || arguments_.length < 2) {
    return undefined;
  }

  const requires: ClaimRequirement[] = [];
  let index = 1;
  while (index < arguments_.length) {
    if (arguments_[index] !== '--require') {
      return undefined;
    }

    const evidenceId = arguments_[index + 1];
    if (!isCliValue(evidenceId)) {
      return undefined;
    }
    index += 2;

    let requirement: ClaimRequirement = { evidenceId };
    if (arguments_[index] === '--subject') {
      const subject = arguments_[index + 1];
      if (!isSingleTokenSubject(subject)) {
        return undefined;
      }
      requirement = { evidenceId, subject };
      index += 2;
    }
    requires.push(requirement);
  }

  return requires.length === 0 ? undefined : { id, requires };
}

type ParsedEvidence = {
  readonly id: string;
  readonly outcome: 'confirmed' | 'refuted' | 'unknown';
  readonly subject?: string;
};

function parseEvidenceArguments(
  arguments_: readonly string[],
): ParsedEvidence | undefined {
  const id = arguments_[0];
  const outcome = arguments_[1];
  if (!isCliValue(id) || !isEvidenceOutcome(outcome)) {
    return undefined;
  }

  if (arguments_.length === 2) {
    return { id, outcome };
  }
  if (arguments_[2] !== 'subject' || arguments_.length < 4) {
    return undefined;
  }

  const subject = arguments_.slice(3).join(' ');
  return isValidIdentifier(subject) ? { id, outcome, subject } : undefined;
}

function parseSingleId(arguments_: readonly string[]): string | undefined {
  const id = arguments_[0];
  return arguments_.length === 1 && isCliValue(id) ? id : undefined;
}

function showStatus(
  ctx: ExtensionCommandContext,
  controller: StateController,
): void {
  notify(ctx, formatEvidenceState(controller.getState()));
}

function recordClaim(
  ctx: ExtensionCommandContext,
  controller: StateController,
  arguments_: readonly string[],
): void {
  const parsed = parseClaimAddArguments(arguments_);
  if (parsed === undefined) {
    notify(ctx, USAGE, 'warning');
    return;
  }

  const result = addClaim(controller.getState(), parsed.id, parsed.requires);
  if (!result.changed) {
    notify(ctx, invalidMutationMessage(), 'warning');
    return;
  }

  controller.replaceState(result.state);
  controller.persist();
  notify(
    ctx,
    `${NOTIFICATION_PREFIX}recorded claim "${parsed.id}"; ${result.state.claims.length} ${result.state.claims.length === 1 ? 'claim' : 'claims'} in the current session.`,
  );
}

function deleteClaim(
  ctx: ExtensionCommandContext,
  controller: StateController,
  arguments_: readonly string[],
): void {
  const id = parseSingleId(arguments_);
  if (id === undefined) {
    notify(ctx, USAGE, 'warning');
    return;
  }

  const result = removeClaim(controller.getState(), id);
  if (!result.changed) {
    notify(
      ctx,
      result.reason === 'not_found'
        ? unknownClaimMessage(id)
        : invalidMutationMessage(),
      'warning',
    );
    return;
  }

  controller.replaceState(result.state);
  controller.persist();
  notify(ctx, `${NOTIFICATION_PREFIX}removed claim "${id}".`);
}

function recordEvidence(
  ctx: ExtensionCommandContext,
  controller: StateController,
  arguments_: readonly string[],
  replace: boolean,
): void {
  const parsed = parseEvidenceArguments(arguments_);
  if (parsed === undefined) {
    notify(ctx, USAGE, 'warning');
    return;
  }

  const current = controller.getState();
  const result = replace
    ? parsed.subject === undefined
      ? replaceEvidence(current, parsed.id, parsed.outcome)
      : replaceEvidence(current, parsed.id, parsed.outcome, parsed.subject)
    : parsed.subject === undefined
      ? addEvidence(current, parsed.id, parsed.outcome)
      : addEvidence(current, parsed.id, parsed.outcome, parsed.subject);

  if (!result.changed) {
    notify(
      ctx,
      replace && result.reason === 'not_found'
        ? unknownEvidenceMessage(parsed.id)
        : invalidMutationMessage(),
      'warning',
    );
    return;
  }

  controller.replaceState(result.state);
  controller.persist();
  notify(
    ctx,
    replace
      ? `${NOTIFICATION_PREFIX}replaced evidence "${parsed.id}".`
      : `${NOTIFICATION_PREFIX}recorded evidence "${parsed.id}" with outcome=${parsed.outcome}.`,
  );
}

function deleteEvidence(
  ctx: ExtensionCommandContext,
  controller: StateController,
  arguments_: readonly string[],
): void {
  const id = parseSingleId(arguments_);
  if (id === undefined) {
    notify(ctx, USAGE, 'warning');
    return;
  }

  const result = removeEvidence(controller.getState(), id);
  if (!result.changed) {
    notify(
      ctx,
      result.reason === 'not_found'
        ? unknownEvidenceMessage(id)
        : invalidMutationMessage(),
      'warning',
    );
    return;
  }

  controller.replaceState(result.state);
  controller.persist();
  notify(ctx, `${NOTIFICATION_PREFIX}removed evidence "${id}".`);
}

function judgeCurrent(
  ctx: ExtensionCommandContext,
  controller: StateController,
): void {
  try {
    notify(ctx, formatEvidenceVerdict(judgeState(controller.getState())));
  } catch (error: unknown) {
    notify(ctx, formatEvidenceError(error), 'warning');
  }
}

function clearCurrent(
  ctx: ExtensionCommandContext,
  controller: StateController,
): void {
  const result = clearState(controller.getState());
  if (!result.changed) {
    notify(
      ctx,
      result.reason === 'no_change'
        ? alreadyClearMessage()
        : invalidMutationMessage(),
      result.reason === 'no_change' ? 'info' : 'warning',
    );
    return;
  }

  controller.replaceState(result.state);
  controller.persist();
  notify(ctx, `${NOTIFICATION_PREFIX}cleared claims and evidence.`);
}

function handleCommand(
  args: string,
  ctx: ExtensionCommandContext,
  controller: StateController,
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
    case 'claim': {
      const operation = arguments_[0];
      const operationArguments = arguments_.slice(1);
      if (operation === 'add') {
        recordClaim(ctx, controller, operationArguments);
      } else if (operation === 'remove') {
        deleteClaim(ctx, controller, operationArguments);
      } else {
        notify(ctx, USAGE, 'warning');
      }
      return;
    }
    case 'evidence': {
      const operation = arguments_[0];
      const operationArguments = arguments_.slice(1);
      if (operation === 'add') {
        recordEvidence(ctx, controller, operationArguments, false);
      } else if (operation === 'replace') {
        recordEvidence(ctx, controller, operationArguments, true);
      } else if (operation === 'remove') {
        deleteEvidence(ctx, controller, operationArguments);
      } else {
        notify(ctx, USAGE, 'warning');
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
      if (arguments_.length === 0) {
        notify(ctx, confirmationRequiredMessage(), 'warning');
      } else if (arguments_.length === 1 && arguments_[0] === '--yes') {
        clearCurrent(ctx, controller);
      } else {
        notify(ctx, USAGE, 'warning');
      }
      return;
    default:
      notify(ctx, USAGE, 'warning');
  }
}

export function registerAgentEvidenceCommand(
  pi: ExtensionAPI,
  controller: StateController,
): void {
  pi.registerCommand(COMMAND_NAME, {
    description: 'Record and explicitly judge caller-declared evidence.',
    handler: async (args, ctx): Promise<void> => {
      handleCommand(args, ctx, controller);
    },
  });
}
