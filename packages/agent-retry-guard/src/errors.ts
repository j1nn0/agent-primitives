import type { RetryErrorCode } from './types.js';

export class RetryError extends Error {
  readonly code: RetryErrorCode;

  constructor(code: RetryErrorCode, message: string) {
    super(message);
    this.name = 'RetryError';
    this.code = code;
  }
}
