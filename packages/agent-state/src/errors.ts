import type { AgentStateErrorCode } from './types.js';

export class AgentStateError extends Error {
  readonly code: AgentStateErrorCode;
  readonly itemId?: string;

  constructor(code: AgentStateErrorCode, message: string, itemId?: string) {
    super(message);
    this.name = 'AgentStateError';
    this.code = code;
    if (itemId !== undefined) {
      this.itemId = itemId;
    }
  }
}
