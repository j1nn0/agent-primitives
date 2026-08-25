import { AgentStateError } from '@j1nn0/agent-state';

export function formatStateError(error: unknown): string {
  if (error instanceof AgentStateError) {
    const message = error.message;
    const lowerCaseMessage =
      message.length === 0
        ? 'invalid input.'
        : `${message[0]?.toLocaleLowerCase() ?? ''}${message.slice(1)}`;
    return `Agent State: ${lowerCaseMessage}`;
  }
  return 'Agent State: invalid input.';
}
