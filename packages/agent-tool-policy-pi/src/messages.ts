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

const APPROVAL_PREVIEW_KEYS: Record<string, readonly string[]> = {
  bash: ['command'],
  powershell: ['command'],
  read: ['path'],
  edit: ['path'],
  write: ['path'],
  grep: ['pattern', 'path', 'glob'],
  find: ['pattern', 'path'],
  ls: ['path'],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEnumerableDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } {
  if (descriptor === undefined) {
    return false;
  }

  const descriptorKeys = Object.keys(descriptor);
  return (
    descriptorKeys.length === 4 &&
    descriptorKeys.every((key) => ['value', 'writable', 'enumerable', 'configurable'].includes(key)) &&
    !Object.prototype.hasOwnProperty.call(descriptor, 'get') &&
    !Object.prototype.hasOwnProperty.call(descriptor, 'set') &&
    Object.prototype.hasOwnProperty.call(descriptor, 'value') &&
    Object.prototype.hasOwnProperty.call(descriptor, 'writable') &&
    Object.prototype.hasOwnProperty.call(descriptor, 'enumerable') &&
    Object.prototype.hasOwnProperty.call(descriptor, 'configurable') &&
    descriptor.enumerable === true &&
    typeof descriptor.writable === 'boolean' &&
    typeof descriptor.configurable === 'boolean'
  );
}

const REMAINING_CONTROL_PATTERN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'g',
);

function normalizePreviewValue(value: string): string {
  return value
    .replace(/\r\n|\n/g, ' ⏎ ')
    .replace(/\t/g, ' ')
    .replace(REMAINING_CONTROL_PATTERN, '');
}

function previewLines(toolName: string, input: unknown): string[] {
  if (!Object.prototype.hasOwnProperty.call(APPROVAL_PREVIEW_KEYS, toolName) || !isPlainObject(input)) {
    return [];
  }

  const keys = APPROVAL_PREVIEW_KEYS[toolName];
  if (keys === undefined) {
    return [];
  }

  const lines: string[] = [];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      continue;
    }

    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!isEnumerableDataDescriptor(descriptor)) {
      continue;
    }

    const value = descriptor.value;
    if (typeof value !== 'string' || value.trim().length === 0) {
      continue;
    }

    const normalized = normalizePreviewValue(value);

    if (normalized.trim().length === 0) {
      continue;
    }
    const rendered = normalized.length > 120 ? `${normalized.slice(0, 120)}... [truncated]` : normalized;
    lines.push(`${key}: ${rendered}`);
  }
  return lines;
}
export function approvalMessage(toolName: string): string {
  return `Allow tool call "${toolName}"? This tool requires approval under the active policy.`;
}

export function approvalMessageWithPreview(toolName: string, input: unknown): string {
  try {
    const lines = previewLines(toolName, input);
    if (lines.length === 0) {
      return approvalMessage(toolName);
    }
    return `${approvalMessage(toolName)}\n${lines.join('\n')}`;
  } catch {
    return approvalMessage(toolName);
  }
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
