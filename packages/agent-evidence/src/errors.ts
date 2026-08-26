import type { EvidenceErrorCode } from './types.js';

export class EvidenceError extends Error {
  readonly code: EvidenceErrorCode;

  constructor(code: EvidenceErrorCode, message: string) {
    super(message);
    this.name = 'EvidenceError';
    this.code = code;
  }
}
