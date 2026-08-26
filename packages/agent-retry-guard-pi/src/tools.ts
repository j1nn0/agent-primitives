import {
  type AgentToolResult,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import type {
  RetryAttemptOutcome,
  RetryPolicy,
} from '@j1nn0/agent-retry-guard';
import { formatRetryState, formatRetryVerdict } from './display.js';
import {
  formatRetryError,
  invalidToolParametersMessage,
  NOTIFICATION_PREFIX,
} from './messages.js';
import {
  addAttempt,
  isPositiveInteger,
  isRetryAttemptOutcome,
  isValidStrategyId,
  judgeState,
  setPolicy,
  startEpisode,
  type StateController,
} from './state.js';

export const TOOL_NAMES = [
  'agent_retry_get',
  'agent_retry_add_attempt',
  'agent_retry_set_policy',
  'agent_retry_judge',
  'agent_retry_start_episode',
] as const;

const GET_PARAMETERS = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

const ADD_ATTEMPT_PARAMETERS = {
  type: 'object',
  properties: {
    outcome: {
      type: 'string',
      enum: ['success', 'failure', 'no_progress', 'unknown'],
      description: 'Exact caller-declared outcome for this retry attempt.',
    },
    strategyId: {
      type: 'string',
      description: 'Caller-supplied opaque strategy identifier, preserved exactly.',
    },
  },
  required: ['outcome'],
  additionalProperties: false,
} as const;

const SET_POLICY_PARAMETERS = {
  type: 'object',
  properties: {
    maxAttempts: {
      type: 'integer',
      minimum: 1,
      description: 'Maximum attempts permitted in the current retry episode.',
    },
    maxStrategyAttempts: {
      type: 'integer',
      minimum: 1,
      description: 'Maximum trailing attempts for one identified strategy.',
    },
  },
  additionalProperties: false,
} as const;

type TextToolResult = AgentToolResult<undefined>;

function textResult(text: string): TextToolResult {
  return {
    content: [{ type: 'text' as const, text }],
    details: undefined,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasNoParameters(value: unknown): boolean {
  return isPlainRecord(value) && Object.keys(value).length === 0;
}

function parseAttemptParameters(value: unknown):
  | { readonly outcome: RetryAttemptOutcome; readonly strategyId?: string }
  | undefined {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ['outcome', 'strategyId']) ||
    !hasOwn(value, 'outcome') ||
    !isRetryAttemptOutcome(value.outcome)
  ) {
    return undefined;
  }

  if (!hasOwn(value, 'strategyId')) {
    return { outcome: value.outcome };
  }
  return isValidStrategyId(value.strategyId)
    ? { outcome: value.outcome, strategyId: value.strategyId }
    : undefined;
}

function parsePolicyParameters(value: unknown): RetryPolicy | undefined {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ['maxAttempts', 'maxStrategyAttempts'])
  ) {
    return undefined;
  }

  let maxAttempts: number | undefined;
  if (hasOwn(value, 'maxAttempts')) {
    if (!isPositiveInteger(value.maxAttempts)) {
      return undefined;
    }
    maxAttempts = value.maxAttempts;
  }

  let maxStrategyAttempts: number | undefined;
  if (hasOwn(value, 'maxStrategyAttempts')) {
    if (!isPositiveInteger(value.maxStrategyAttempts)) {
      return undefined;
    }
    maxStrategyAttempts = value.maxStrategyAttempts;
  }

  return {
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(maxStrategyAttempts === undefined
      ? {}
      : { maxStrategyAttempts }),
  };
}

function addAttemptToolResult(
  controller: StateController,
  params: unknown,
): string {
  const parsed = parseAttemptParameters(params);
  if (parsed === undefined) {
    return invalidToolParametersMessage();
  }

  const result = addAttempt(
    controller.getState(),
    parsed.outcome,
    parsed.strategyId,
  );
  if (!result.changed) {
    return invalidToolParametersMessage();
  }

  controller.replaceState(result.state);
  controller.persist();
  return `${NOTIFICATION_PREFIX}recorded ${parsed.outcome} attempt; ${result.state.attempts.length} ${result.state.attempts.length === 1 ? 'attempt' : 'attempts'} in the current episode.`;
}

function setPolicyToolResult(
  controller: StateController,
  params: unknown,
): string {
  const policy = parsePolicyParameters(params);
  if (policy === undefined) {
    return invalidToolParametersMessage();
  }

  const result = setPolicy(controller.getState(), policy);
  if (!result.changed) {
    return `${NOTIFICATION_PREFIX}policy unchanged.`;
  }

  controller.replaceState(result.state);
  controller.persist();
  const policyText =
    Object.keys(policy).length === 0
      ? 'no policy set'
      : Object.entries(policy)
          .map(([key, value]) => `${key}=${value}`)
          .join(', ');
  return `${NOTIFICATION_PREFIX}policy set to ${policyText}.`;
}

function startEpisodeToolResult(
  controller: StateController,
  params: unknown,
): string {
  if (!hasNoParameters(params)) {
    return invalidToolParametersMessage();
  }

  const result = startEpisode(controller.getState());
  if (!result.changed) {
    return `${NOTIFICATION_PREFIX}new episode not started; attempts were already empty (policy preserved).`;
  }

  controller.replaceState(result.state);
  controller.persist();
  return `${NOTIFICATION_PREFIX}new episode started; attempts reset (policy preserved).`;
}

export function registerAgentRetryTools(
  pi: ExtensionAPI,
  controller: StateController,
): void {
  pi.registerTool({
    name: 'agent_retry_get',
    label: 'Agent Retry Guard: get',
    description:
      'Read the current caller-declared retry episode and policy as readable text. This reports what was recorded and does not judge, infer outcomes, generate strategy identifiers, map Progress verdicts, execute retries, or verify truth.',
    parameters: GET_PARAMETERS,
    execute: async (_id, params) =>
      hasNoParameters(params)
        ? textResult(formatRetryState(controller.getState()))
        : textResult(invalidToolParametersMessage()),
  });

  pi.registerTool({
    name: 'agent_retry_add_attempt',
    label: 'Agent Retry Guard: add attempt',
    description:
      'Record one caller-declared retry attempt. This tool does not infer outcomes, generate strategy identifiers, map Progress verdicts, execute retries, or verify truth.',
    parameters: ADD_ATTEMPT_PARAMETERS,
    execute: async (_id, params) => {
      try {
        return textResult(addAttemptToolResult(controller, params));
      } catch (error: unknown) {
        return textResult(formatRetryError(error));
      }
    },
  });

  pi.registerTool({
    name: 'agent_retry_set_policy',
    label: 'Agent Retry Guard: set policy',
    description:
      'Replace the whole caller-declared retry policy; omitted limits are cleared. This tool does not infer outcomes, generate strategy identifiers, map Progress verdicts, execute retries, or verify truth.',
    parameters: SET_POLICY_PARAMETERS,
    execute: async (_id, params) => {
      try {
        return textResult(setPolicyToolResult(controller, params));
      } catch (error: unknown) {
        return textResult(formatRetryError(error));
      }
    },
  });

  pi.registerTool({
    name: 'agent_retry_judge',
    label: 'Agent Retry Guard: judge',
    description:
      'Judge the current caller-declared retry episode by delegating to the Retry Guard core. This tool does not infer outcomes, generate strategy identifiers, map Progress verdicts, execute retries, or verify truth.',
    parameters: GET_PARAMETERS,
    execute: async (_id, params) => {
      if (!hasNoParameters(params)) {
        return textResult(invalidToolParametersMessage());
      }
      try {
        return textResult(formatRetryVerdict(judgeState(controller.getState())));
      } catch (error: unknown) {
        return textResult(formatRetryError(error));
      }
    },
  });

  pi.registerTool({
    name: 'agent_retry_start_episode',
    label: 'Agent Retry Guard: start episode',
    description:
      'Explicitly start a new retry episode at model or caller discretion; this resets attempts while preserving policy and is never triggered automatically by success. This tool does not infer outcomes, generate strategy identifiers, map Progress verdicts, execute retries, or verify truth.',
    parameters: GET_PARAMETERS,
    execute: async (_id, params) => {
      try {
        return textResult(startEpisodeToolResult(controller, params));
      } catch (error: unknown) {
        return textResult(formatRetryError(error));
      }
    },
  });
}
