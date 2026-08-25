import {
  type AgentToolResult,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import {
  type WorkItemInput,
} from '@j1nn0/agent-state';
import { formatAgentState } from './display.js';
import { formatStateError } from './messages.js';
import type { StateController } from './state.js';

export const TOOL_NAMES = [
  'agent_state_get',
  'agent_state_add_work_item',
  'agent_state_set_work_item_status',
  'agent_state_add_decision',
] as const;

const GET_PARAMETERS = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

const ADD_WORK_ITEM_PARAMETERS = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Caller-supplied work item id.' },
    content: {
      type: 'string',
      description: 'Caller-declared description of the work item.',
    },
    status: {
      type: 'string',
      enum: ['open', 'in_progress', 'blocked', 'done'],
      description: 'Exact caller-declared work item status.',
    },
  },
  required: ['id', 'content'],
  additionalProperties: false,
} as const;

const SET_WORK_ITEM_STATUS_PARAMETERS = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Caller-supplied work item id.' },
    status: {
      type: 'string',
      enum: ['open', 'in_progress', 'blocked', 'done'],
      description: 'Exact caller-declared work item status.',
    },
  },
  required: ['id', 'status'],
  additionalProperties: false,
} as const;

const ADD_DECISION_PARAMETERS = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Caller-supplied decision id.' },
    content: {
      type: 'string',
      description: 'Caller-declared description of the decision.',
    },
  },
  required: ['id', 'content'],
  additionalProperties: false,
} as const;

type TextToolResult = AgentToolResult<undefined>;

function textResult(text: string): TextToolResult {
  return {
    content: [{ type: 'text' as const, text }],
    details: undefined,
  };
}

export function registerAgentStateTools(
  pi: ExtensionAPI,
  controller: StateController,
): void {
  pi.registerTool({
    name: 'agent_state_get',
    label: 'Agent State: get',
    description:
      'Read the current caller-declared Agent State as readable text. This reports what was recorded and asserts nothing about truth, progress, evidence, or completion.',
    parameters: GET_PARAMETERS,
    execute: async () =>
      textResult(formatAgentState(controller.getState())),
  });

  pi.registerTool({
    name: 'agent_state_add_work_item',
    label: 'Agent State: add work item',
    description:
      'Record one caller-declared work item in Agent State. The content and status are claims supplied by the caller; this tool does not infer, verify, or assert their truth, progress, evidence, or completion.',
    parameters: ADD_WORK_ITEM_PARAMETERS,
    execute: async (_id, params) => {
      try {
        const input: WorkItemInput = {
          id: params.id,
          content: params.content,
        };
        if (params.status !== undefined) {
          input.status = params.status;
        }
        controller.getState().addWorkItem(input);
        controller.persist();
        return textResult(`Agent State: added work item "${params.id}".`);
      } catch (error: unknown) {
        return textResult(formatStateError(error));
      }
    },
  });

  pi.registerTool({
    name: 'agent_state_set_work_item_status',
    label: 'Agent State: set work item status',
    description:
      'Set the exact caller-declared status of an existing Agent State work item. This records a claim and does not infer, verify, or assert truth, progress, evidence, or completion.',
    parameters: SET_WORK_ITEM_STATUS_PARAMETERS,
    execute: async (_id, params) => {
      try {
        const state = controller.getState();
        const current = state.getWorkItem(params.id);
        const updated = state.setWorkItemStatus(params.id, params.status);
        if (current?.status !== updated.status) {
          controller.persist();
        }
        return textResult(
          `Agent State: work item "${params.id}" is now ${params.status}.`,
        );
      } catch (error: unknown) {
        return textResult(formatStateError(error));
      }
    },
  });

  pi.registerTool({
    name: 'agent_state_add_decision',
    label: 'Agent State: add decision',
    description:
      'Record one caller-declared decision in Agent State. The content is a claim supplied by the caller; this tool does not infer, verify, or assert its truth, progress, evidence, or completion.',
    parameters: ADD_DECISION_PARAMETERS,
    execute: async (_id, params) => {
      try {
        controller.getState().addDecision({
          id: params.id,
          content: params.content,
        });
        controller.persist();
        return textResult(`Agent State: added decision "${params.id}".`);
      } catch (error: unknown) {
        return textResult(formatStateError(error));
      }
    },
  });
}
