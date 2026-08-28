import type { ToolPolicyVerdict } from '@j1nn0/agent-tool-policy';

export const NOTIFICATION_PREFIX = 'Agent Tool Policy: ';

export const UNCONFIGURED_WARNING =
  `${NOTIFICATION_PREFIX}no policy configured; tool calls are blocked until configured. Recover with /agent-tool-policy set <policy-json> or explicitly disable with /agent-tool-policy clear --yes.`;

export const CORRUPT_WARNING =
  `${NOTIFICATION_PREFIX}policy configuration is invalid; tool calls are blocked until /agent-tool-policy set <policy-json> re-configures it.`;

export const UNCONFIGURED_BLOCK_REASON =
  `${NOTIFICATION_PREFIX}no policy configured; tool call blocked. Configure with /agent-tool-policy set <policy-json> or explicitly disable with /agent-tool-policy clear --yes.`;

export const CORRUPT_BLOCK_REASON =
  `${NOTIFICATION_PREFIX}policy configuration is invalid or corrupted; tool call blocked. Recover with /agent-tool-policy set <policy-json>.`;

export const DENIED_REASON = `${NOTIFICATION_PREFIX}tool call denied by tool policy.`;

export const NO_UI_APPROVAL_REASON =
  `${NOTIFICATION_PREFIX}tool call requires approval, but no UI available; tool call blocked.`;

export const APPROVAL_DENIED_REASON =
  `${NOTIFICATION_PREFIX}tool call requires approval; approval denied or not granted.`;

export const JUDGMENT_FAILED_REASON =
  `${NOTIFICATION_PREFIX}tool policy judgment failed; tool call blocked.`;

export const USAGE =
  `${NOTIFICATION_PREFIX}Usage: /agent-tool-policy status | set <policy-json> | judge <tool> | clear [--yes]`;

export function setPolicyMessage(): string {
  return `${NOTIFICATION_PREFIX}tool policy set; enforcement is active.`;
}

export function invalidPolicyJsonMessage(): string {
  return `${NOTIFICATION_PREFIX}invalid policy JSON; state was unchanged.`;
}

export function invalidPolicyMessage(): string {
  return `${NOTIFICATION_PREFIX}invalid tool policy; state was unchanged.`;
}

export function clearConfirmationMessage(): string {
  return `${NOTIFICATION_PREFIX}clear would disable tool policy and allow all tool calls through. Run /agent-tool-policy clear --yes to confirm.`;
}

export function disabledPolicyMessage(): string {
  return `${NOTIFICATION_PREFIX}Tool policy disabled; all tool calls pass through until a new policy is set. An explicit DISABLED marker (policy: null) was written.`;
}

export function alreadyDisabledMessage(): string {
  return `${NOTIFICATION_PREFIX}Tool policy already disabled; no state was written.`;
}

export function commandFailureMessage(): string {
  return `${NOTIFICATION_PREFIX}tool policy command failed; state was unchanged.`;
}

export function approvalTitle(toolName: string): string {
  return `${NOTIFICATION_PREFIX}Approval required for "${toolName}"`;
}

export function approvalMessage(toolName: string): string {
  return `Allow tool call "${toolName}"? This tool requires approval under the active policy.`;
}

export function judgePolicyMessage(toolName: string, verdict: ToolPolicyVerdict): string {
  return `${NOTIFICATION_PREFIX}judged "${toolName}": outcome=${verdict.outcome}, source=${verdict.source}.`;
}

export function unconfiguredModeMessage(): string {
  return `${NOTIFICATION_PREFIX}mode is unconfigured; tool calls are blocked until /agent-tool-policy set <policy-json> configures a policy.`;
}

export function disabledModeMessage(): string {
  return `${NOTIFICATION_PREFIX}mode is disabled; tool calls pass through. Use /agent-tool-policy set <policy-json> to enable enforcement.`;
}

export function corruptModeMessage(): string {
  return `${NOTIFICATION_PREFIX}mode is corrupted; tool calls are blocked until /agent-tool-policy set <policy-json> re-configures the policy.`;
}
