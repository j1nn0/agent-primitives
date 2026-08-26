import { RetryError } from '@j1nn0/agent-retry-guard';

export const NOTIFICATION_PREFIX = 'Agent Retry Guard: ';
export const USAGE =
  `${NOTIFICATION_PREFIX}Usage: /agent-retry [status] | add <success|failure|no_progress|unknown> [strategyId] | policy [maxAttempts [maxStrategyAttempts] | clear] | judge | clear --yes`;

export function formatRetryError(error: unknown): string {
  if (error instanceof RetryError) {
    const message = error.message;
    const lowerCaseMessage =
      message.length === 0
        ? 'invalid input.'
        : `${message[0]?.toLocaleLowerCase() ?? ''}${message.slice(1)}`;
    return `${NOTIFICATION_PREFIX}${lowerCaseMessage}`;
  }
  return `${NOTIFICATION_PREFIX}invalid retry input.`;
}

export function confirmationRequiredMessage(): string {
  return `${NOTIFICATION_PREFIX}clear requires confirmation; run /agent-retry clear --yes to wipe attempts and policy.`;
}

export function invalidToolParametersMessage(): string {
  return USAGE;
}
