import { EvidenceError } from '@j1nn0/agent-evidence';

export const NOTIFICATION_PREFIX = 'Agent Evidence: ';

export const USAGE = `${NOTIFICATION_PREFIX}Usage: /agent-evidence [status] | claim add <id> --require <evidenceId> [--subject <value>] [--require <evidenceId> [--subject <value>] ...] | claim remove <id> | evidence add <id> <confirmed|refuted|unknown> [subject <value>] | evidence replace <id> <confirmed|refuted|unknown> [subject <value>] | evidence remove <id> | judge | clear --yes`;

export function formatEvidenceError(error: unknown): string {
  if (error instanceof EvidenceError) {
    const message = error.message;
    const lowerCaseMessage =
      message.length === 0
        ? 'invalid input.'
        : `${message[0]?.toLocaleLowerCase() ?? ''}${message.slice(1)}`;
    return `${NOTIFICATION_PREFIX}${lowerCaseMessage}`;
  }
  return `${NOTIFICATION_PREFIX}invalid evidence input.`;
}

export function invalidToolParametersMessage(): string {
  return USAGE;
}

export function invalidMutationMessage(): string {
  return `${NOTIFICATION_PREFIX}change rejected as invalid; common causes include duplicate ids, empty requirements, or malformed fields. State was unchanged.`;
}

export function unknownClaimMessage(id: string): string {
  return `${NOTIFICATION_PREFIX}unknown claim "${id}"; state was unchanged.`;
}

export function unknownEvidenceMessage(id: string): string {
  return `${NOTIFICATION_PREFIX}unknown evidence "${id}"; state was unchanged.`;
}

export function confirmationRequiredMessage(): string {
  return `${NOTIFICATION_PREFIX}clear requires confirmation; run /agent-evidence clear --yes to wipe claims and evidence.`;
}

export function alreadyClearMessage(): string {
  return `${NOTIFICATION_PREFIX}claims and evidence were already clear.`;
}
