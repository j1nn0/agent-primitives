import type { ProgressErrorCode } from './types.js';

export class ProgressError extends Error {
  readonly code: ProgressErrorCode;

  constructor(code: ProgressErrorCode, message: string) {
    super(message);
    this.name = 'ProgressError';
    this.code = code;
  }
}
