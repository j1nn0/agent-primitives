import { HandoffError } from '@j1nn0/agent-handoff';

export const NOTIFICATION_PREFIX = 'Agent Handoff: ';

export const USAGE = `${NOTIFICATION_PREFIX}Usage: /agent-handoff status | show <id> | remove <id> | clear --yes`;

export function formatHandoffError(error: unknown): string {
  if (error instanceof HandoffError) {
    const message = error.message;
    const lowerCaseMessage =
      message.length === 0
        ? 'invalid input.'
        : `${message[0]?.toLocaleLowerCase() ?? ''}${message.slice(1)}`;
    return `${NOTIFICATION_PREFIX}${lowerCaseMessage}`;
  }
  return `${NOTIFICATION_PREFIX}invalid handoff input.`;
}

export function invalidMutationMessage(): string {
  return `${NOTIFICATION_PREFIX}change rejected as invalid; common causes include duplicate ids, empty identifiers, malformed packets, or unknown top-level keys. State was unchanged.`;
}

export function duplicatePacketMessage(id: string): string {
  return `${NOTIFICATION_PREFIX}duplicate packet id "${id}"; state was unchanged.`;
}

export function unknownPacketMessage(id: string): string {
  return `${NOTIFICATION_PREFIX}unknown packet "${id}"; state was unchanged.`;
}

export function confirmationRequiredMessage(): string {
  return `${NOTIFICATION_PREFIX}clear requires confirmation; run /agent-handoff clear --yes to wipe all handoff packets.`;
}

export function alreadyClearMessage(): string {
  return `${NOTIFICATION_PREFIX}packets were already clear.`;
}
