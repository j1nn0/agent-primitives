import { ToolPolicyError, judgeToolPolicy } from '@j1nn0/agent-tool-policy';
import type { ToolPolicy } from '@j1nn0/agent-tool-policy';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export const STATE_CUSTOM_TYPE = 'agent-tool-policy-state' as const;
export const ADAPTER_SCHEMA_VERSION = 1 as const;

const POLICY_PROBE_TOOL = '__policy_probe__';

export interface UnconfiguredState {
  readonly kind: 'unconfigured';
}

export interface DisabledState {
  readonly kind: 'disabled';
}

export interface CorruptState {
  readonly kind: 'corrupt';
}

export interface EnforcingState {
  readonly kind: 'enforcing';
  readonly policy: ToolPolicy;
}

export type PolicyMode = UnconfiguredState | DisabledState | CorruptState | EnforcingState;

export interface PersistedState {
  readonly schemaVersion: 1;
  readonly policy: ToolPolicy | null;
}

export interface StateController {
  readonly getState: () => PolicyMode;
  readonly replaceState: (state: PolicyMode) => void;
  readonly persist: () => void;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === allowed.length &&
    keys.every((key) => typeof key === 'string' && allowed.includes(key))
  );
}

export function isValidToolName(value: unknown): value is string {
  return typeof value === 'string' && /^\S+$/.test(value);
}

export function isValidPolicy(value: unknown): value is ToolPolicy {
  try {
    judgeToolPolicy({ tool: POLICY_PROBE_TOOL, policy: value });
    return true;
  } catch (error: unknown) {
    if (error instanceof ToolPolicyError) {
      return false;
    }
    return false;
  }
}

function copyPolicy(policy: ToolPolicy): ToolPolicy {
  const copy: {
    default: ToolPolicy['default'];
    allow: string[];
    deny: string[];
    requiresApproval?: string[];
  } = {
    default: policy.default,
    allow: [...policy.allow],
    deny: [...policy.deny],
  };

  if (hasOwn(policy, 'requiresApproval')) {
    const requiresApproval = policy.requiresApproval;
    if (requiresApproval === undefined) {
      throw new Error('invalid tool policy');
    }
    copy.requiresApproval = [...requiresApproval];
  }

  return copy;
}

export function createUnconfiguredState(): UnconfiguredState {
  return { kind: 'unconfigured' };
}

export function createDisabledState(): DisabledState {
  return { kind: 'disabled' };
}

export function createCorruptState(): CorruptState {
  return { kind: 'corrupt' };
}

export function createEnforcingState(policy: ToolPolicy): EnforcingState {
  return { kind: 'enforcing', policy: copyPolicy(policy) };
}

export function parsePersistedState(value: unknown): PolicyMode | undefined {
  try {
    if (
      !isPlainRecord(value) ||
      !hasOnlyKeys(value, ['schemaVersion', 'policy']) ||
      !hasOwn(value, 'schemaVersion') ||
      value.schemaVersion !== ADAPTER_SCHEMA_VERSION ||
      !hasOwn(value, 'policy')
    ) {
      return undefined;
    }

    if (value.policy === null) {
      return createDisabledState();
    }

    if (!isValidPolicy(value.policy)) {
      return undefined;
    }

    return createEnforcingState(value.policy);
  } catch {
    return undefined;
  }
}

export function loadState(
  ctx: Pick<ExtensionContext, 'sessionManager'>,
): PolicyMode {
  try {
    const latestStateEntry = ctx.sessionManager
      .getBranch()
      .filter((entry) => entry.type === 'custom' && entry.customType === STATE_CUSTOM_TYPE)
      .at(-1);

    if (latestStateEntry === undefined || latestStateEntry.type !== 'custom') {
      return createUnconfiguredState();
    }

    return parsePersistedState(latestStateEntry.data) ?? createCorruptState();
  } catch {
    return createCorruptState();
  }
}

export function saveState(
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  state: PolicyMode,
): void {
  let payload: PersistedState;

  switch (state.kind) {
    case 'disabled':
      payload = {
        schemaVersion: ADAPTER_SCHEMA_VERSION,
        policy: null,
      };
      break;
    case 'enforcing':
      if (!isValidPolicy(state.policy)) {
        throw new Error('invalid tool policy');
      }
      payload = {
        schemaVersion: ADAPTER_SCHEMA_VERSION,
        policy: copyPolicy(state.policy),
      };
      break;
    case 'unconfigured':
    case 'corrupt':
      throw new Error('cannot persist a non-persistable tool policy state');
  }

  pi.appendEntry(STATE_CUSTOM_TYPE, payload);
}
