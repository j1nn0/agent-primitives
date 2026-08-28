import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { formatHandoffStateDetailed } from './display.js';
import { duplicatePacketMessage, formatHandoffError, invalidMutationMessage } from './messages.js';
import { createPacket, isValidIdentifier, removePacket, type StateController } from './state.js';

export const TOOL_NAMES = [
  'agent_handoff_get',
  'agent_handoff_create',
  'agent_handoff_remove',
] as const;

const GET_PARAMETERS = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

const CREATE_PARAMETERS = {
  type: 'object',
  properties: {
    schemaVersion: {
      type: 'integer',
      const: 1,
      description: 'Required schema version; must be 1.',
    },
    id: {
      type: 'string',
      description: 'Caller-supplied packet identifier, preserved exactly.',
    },
    source: {
      type: 'string',
      description: 'Caller-supplied source identifier, preserved exactly.',
    },
    destination: {
      type: 'string',
      description: 'Optional destination identifier, preserved exactly.',
    },
    goal: {
      type: 'string',
      description: 'Caller-supplied goal prose, preserved exactly.',
    },
    constraints: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional caller-supplied prose restrictions; duplicates allowed.',
    },
    openItems: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional caller-supplied open items prose; duplicates allowed.',
    },
    evidenceReferences: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional caller-supplied opaque evidence references; exact duplicates are rejected.',
    },
  },
  required: ['schemaVersion', 'id', 'source', 'goal'],
  additionalProperties: false,
} as const;

const REMOVE_PARAMETERS = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: 'Caller-supplied packet identifier to remove.',
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

function createToolResult(controller: StateController, params: unknown): string {
  const result = createPacket(controller.getState(), params);
  if (!result.changed) {
    if (result.reason === 'duplicate') {
      const id =
        typeof (params as Record<string, unknown>)?.id === 'string'
          ? String((params as Record<string, unknown>).id)
          : 'unknown';
      return duplicatePacketMessage(id);
    }
    return invalidMutationMessage();
  }

  controller.replaceState(result.state);
  controller.persist();
  const id = (params as Record<string, unknown>).id as string;
  return `Agent Handoff: created packet "${id}"; ${result.state.packets.length} ${result.state.packets.length === 1 ? 'packet' : 'packets'} in the current session.`;
}

function removeToolResult(controller: StateController, params: unknown): string {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return invalidMutationMessage();
  }
  const record = params as Record<string, unknown>;
  if (!('id' in record)) {
    return invalidMutationMessage();
  }
  const id = record.id;
  if (!isValidIdentifier(id)) {
    return invalidMutationMessage();
  }

  const result = removePacket(controller.getState(), id);
  if (!result.changed) {
    return result.reason === 'not_found'
      ? `Agent Handoff: unknown packet "${String(id)}"; state was unchanged.`
      : invalidMutationMessage();
  }

  controller.replaceState(result.state);
  controller.persist();
  return `Agent Handoff: removed packet "${String(id)}"; ${result.state.packets.length} ${result.state.packets.length === 1 ? 'packet' : 'packets'} remain.`;
}

export function registerAgentHandoffTools(pi: ExtensionAPI, controller: StateController): void {
  pi.registerTool({
    name: 'agent_handoff_get',
    label: 'Agent Handoff: get',
    description:
      'Read the current caller-declared handoff packets as readable text. This reports what was recorded and asserts nothing about completion, truth, or readiness. It does not generate packets automatically, summarize context, select successors, judge completion, or call Evidence/State/Progress/Retry/Context Guard.',
    parameters: GET_PARAMETERS,
    execute: async () => textResult(formatHandoffStateDetailed(controller.getState())),
  });

  pi.registerTool({
    name: 'agent_handoff_create',
    label: 'Agent Handoff: create',
    description:
      'Create one caller-declared handoff packet after validation by the core createHandoff function. The packet is persisted only when validation and packet-id uniqueness succeed. This tool does not generate packets automatically, summarize context, select successors, judge completion, or call Evidence/State/Progress/Retry/Context Guard.',
    parameters: CREATE_PARAMETERS,
    execute: async (_id, params) => {
      try {
        return textResult(createToolResult(controller, params));
      } catch (error: unknown) {
        return textResult(formatHandoffError(error));
      }
    },
  });

  pi.registerTool({
    name: 'agent_handoff_remove',
    label: 'Agent Handoff: remove',
    description:
      'Remove one caller-declared handoff packet by identifier. This tool does not generate packets automatically, summarize context, select successors, judge completion, or call Evidence/State/Progress/Retry/Context Guard.',
    parameters: REMOVE_PARAMETERS,
    execute: async (_id, params) => {
      try {
        return textResult(removeToolResult(controller, params));
      } catch (error: unknown) {
        return textResult(formatHandoffError(error));
      }
    },
  });
}
