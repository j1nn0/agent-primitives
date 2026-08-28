import type { ToolPolicyErrorCode } from './types.js';

export class ToolPolicyError extends Error {
  readonly code: ToolPolicyErrorCode;

  constructor(code: ToolPolicyErrorCode, message: string) {
    super(message);
    this.name = 'ToolPolicyError';
    this.code = code;
  }
}
