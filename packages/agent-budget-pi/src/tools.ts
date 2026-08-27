import { judgeBudget } from '@j1nn0/agent-budget';
import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { formatStateSummary, judgeBudgetText } from './display.js';
import {
  createdBudgetMessage,
  formatBudgetError,
  invalidBudgetInputMessage,
  removedBudgetMessage,
  replacedBudgetMessage,
  unchangedBudgetMessage,
  unknownBudgetMessage,
} from './messages.js';
import {
  hasOnlyKeys,
  hasOwn,
  isPlainRecord,
  isValidIdentifier,
  removeBudget,
  type PersistedRecord,
  type StateController,
  upsertBudget,
} from './state.js';

export const TOOL_NAMES = [
  'agent_budget_get',
  'agent_budget_set',
  'agent_budget_remove',
  'agent_budget_judge',
] as const;

const ACCOUNTING_NOTE =
  'It does not count tool calls, tokens, cost, retries, elapsed time, or sub-agent launches automatically; consumption is caller-declared, units belong to the caller, and verdicts are never stored.';

const GET_PARAMETERS = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

const SET_PARAMETERS = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: 'Opaque caller-supplied id preserved exactly.',
    },
    consumed: {
      type: 'number',
      description: 'Caller-declared finite non-negative number; fractional values are allowed; unit-free.',
    },
    limit: {
      type: 'number',
      description: 'Caller-declared finite non-negative number; fractional values are allowed; unit-free.',
    },
  },
  required: ['id', 'consumed', 'limit'],
  additionalProperties: false,
} as const;

const REMOVE_PARAMETERS = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: 'Opaque caller-supplied id to remove; matched exactly.',
    },
  },
  required: ['id'],
  additionalProperties: false,
} as const;

type TextToolResult = AgentToolResult<undefined>;

function textResult(text: string): TextToolResult {
  return {
    content: [{ type: 'text' as const, text }],
    details: undefined,
  };
}

function parseSetParameters(params: unknown): PersistedRecord | undefined {
  if (
    !isPlainRecord(params) ||
    !hasOnlyKeys(params, ['id', 'consumed', 'limit']) ||
    !hasOwn(params, 'id') ||
    !hasOwn(params, 'consumed') ||
    !hasOwn(params, 'limit')
  ) {
    return undefined;
  }

  const id = params.id;
  if (!isValidIdentifier(id)) {
    return undefined;
  }

  const consumed = params.consumed as number;
  const limit = params.limit as number;
  try {
    judgeBudget({ consumed, limit });
  } catch {
    return undefined;
  }

  return { id, consumed, limit };
}

function parseRemoveParameters(params: unknown): string | undefined {
  if (
    !isPlainRecord(params) ||
    !hasOnlyKeys(params, ['id']) ||
    !hasOwn(params, 'id') ||
    !isValidIdentifier(params.id)
  ) {
    return undefined;
  }
  return params.id;
}

function setToolResult(controller: StateController, params: unknown): string {
  const candidate = parseSetParameters(params);
  if (candidate === undefined) {
    return invalidBudgetInputMessage();
  }

  const result = upsertBudget(controller.getState(), candidate);
  if (!result.changed) {
    return result.reason === 'unchanged'
      ? unchangedBudgetMessage(candidate.id)
      : invalidBudgetInputMessage();
  }

  controller.replaceState(result.state);
  controller.persist();
  return result.reason === 'created'
    ? createdBudgetMessage(candidate.id)
    : replacedBudgetMessage(candidate.id);
}

function removeToolResult(controller: StateController, params: unknown): string {
  const id = parseRemoveParameters(params);
  if (id === undefined) {
    return invalidBudgetInputMessage();
  }

  const result = removeBudget(controller.getState(), id);
  if (!result.changed) {
    return unknownBudgetMessage(id);
  }

  controller.replaceState(result.state);
  controller.persist();
  return removedBudgetMessage(id);
}

export function registerAgentBudgetTools(pi: ExtensionAPI, controller: StateController): void {
  pi.registerTool({
    name: 'agent_budget_get',
    label: 'Agent Budget: get',
    description: `Read the current caller-declared budget records as readable text. ${ACCOUNTING_NOTE}`,
    parameters: GET_PARAMETERS,
    execute: async () => {
      try {
        return textResult(formatStateSummary(controller.getState()));
      } catch (error: unknown) {
        return textResult(formatBudgetError(error));
      }
    },
  });

  pi.registerTool({
    name: 'agent_budget_set',
    label: 'Agent Budget: set',
    description: `Create or replace one whole caller-declared budget record. ${ACCOUNTING_NOTE}`,
    parameters: SET_PARAMETERS,
    execute: async (_id, params) => {
      try {
        return textResult(setToolResult(controller, params));
      } catch (error: unknown) {
        return textResult(formatBudgetError(error));
      }
    },
  });

  pi.registerTool({
    name: 'agent_budget_remove',
    label: 'Agent Budget: remove',
    description: `Remove one caller-declared budget record by exact id. ${ACCOUNTING_NOTE}`,
    parameters: REMOVE_PARAMETERS,
    execute: async (_id, params) => {
      try {
        return textResult(removeToolResult(controller, params));
      } catch (error: unknown) {
        return textResult(formatBudgetError(error));
      }
    },
  });

  pi.registerTool({
    name: 'agent_budget_judge',
    label: 'Agent Budget: judge',
    description: `Judge all current caller-declared budgets without changing state or storing verdicts. ${ACCOUNTING_NOTE}`,
    parameters: GET_PARAMETERS,
    execute: async () => {
      try {
        return textResult(judgeBudgetText(controller.getState()));
      } catch (error: unknown) {
        return textResult(formatBudgetError(error));
      }
    },
  });
}
