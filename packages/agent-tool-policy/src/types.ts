export type ToolPolicyOutcome = 'allowed' | 'denied' | 'requires_approval';
export type ToolPolicySource = 'rule' | 'default';
export type ToolPolicyDefaultAction = 'allow' | 'deny' | 'requires_approval';
export type ToolPolicyErrorCode = 'invalid_input';

export interface ToolPolicy {
  readonly default: ToolPolicyDefaultAction;
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly requiresApproval?: readonly string[];
}

export interface ToolPolicyJudgeInput {
  readonly tool: string;
  readonly policy: ToolPolicy;
}

export interface ToolPolicyVerdict {
  readonly outcome: ToolPolicyOutcome;
  readonly source: ToolPolicySource;
}
