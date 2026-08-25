import { ProgressError } from '@j1nn0/agent-progress';

export const NOTIFICATION_PREFIX = 'Agent Progress: ';
export const USAGE =
  `${NOTIFICATION_PREFIX}Usage: /agent-progress status | add <milestone> | withdraw <milestone> | judge | clear --yes`;

export function formatProgressError(error: unknown): string {
  if (error instanceof ProgressError) {
    const message = error.message;
    const lowerCaseMessage =
      message.length === 0
        ? 'invalid input.'
        : `${message[0]?.toLocaleLowerCase() ?? ''}${message.slice(1)}`;
    return `${NOTIFICATION_PREFIX}${lowerCaseMessage}`;
  }
  return `${NOTIFICATION_PREFIX}invalid input.`;
}

export function invalidMilestoneMessage(): string {
  return `${NOTIFICATION_PREFIX}invalid milestone.`;
}

export function duplicateMilestoneMessage(milestone: string): string {
  return `${NOTIFICATION_PREFIX}milestone "${milestone}" is already declared.`;
}

export function unknownMilestoneMessage(milestone: string): string {
  return `${NOTIFICATION_PREFIX}unknown declared milestone "${milestone}".`;
}
