import type { ContextGuardErrorCode } from './types.js';

export class ContextGuardError extends Error {
  readonly code: ContextGuardErrorCode;
  readonly itemId?: string;

  constructor(code: ContextGuardErrorCode, message: string, itemId?: string) {
    super(message);
    this.name = 'ContextGuardError';
    this.code = code;
    if (itemId !== undefined) {
      this.itemId = itemId;
    }
  }
}
