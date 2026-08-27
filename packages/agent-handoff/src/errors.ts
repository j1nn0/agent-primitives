import type { HandoffErrorCode } from './types.js';

export class HandoffError extends Error {
  readonly code: HandoffErrorCode;

  constructor(code: HandoffErrorCode, message: string) {
    super(message);
    this.name = 'HandoffError';
    this.code = code;
  }
}
