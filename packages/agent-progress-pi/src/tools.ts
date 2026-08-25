import {
  type AgentToolResult,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { formatProgressState, formatProgressVerdict } from './display.js';
import {
  duplicateMilestoneMessage,
  formatProgressError,
  invalidMilestoneMessage,
  NOTIFICATION_PREFIX,
  unknownMilestoneMessage,
} from './messages.js';
import {
  addMilestone,
  judgeState,
  type StateController,
  withdrawMilestone,
} from './state.js';

export const TOOL_NAMES = [
  'agent_progress_get',
  'agent_progress_add_milestone',
  'agent_progress_withdraw_milestone',
  'agent_progress_judge',
] as const;

const GET_PARAMETERS = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

const MILESTONE_PARAMETERS = {
  type: 'object',
  properties: {
    milestone: {
      type: 'string',
      description: 'Caller-supplied opaque milestone identifier.',
    },
  },
  required: ['milestone'],
  additionalProperties: false,
} as const;

type TextToolResult = AgentToolResult<undefined>;

function textResult(text: string): TextToolResult {
  return {
    content: [{ type: 'text' as const, text }],
    details: undefined,
  };
}

function addToolResult(
  controller: StateController,
  milestone: unknown,
): string {
  const result = addMilestone(controller.getState(), milestone);
  if (!result.changed) {
    if (result.reason === 'invalid') {
      return invalidMilestoneMessage();
    }
    return duplicateMilestoneMessage(String(milestone));
  }

  controller.replaceState(result.state);
  controller.persist();
  return `${NOTIFICATION_PREFIX}added milestone "${String(milestone)}".`;
}

function withdrawToolResult(
  controller: StateController,
  milestone: unknown,
): string {
  const result = withdrawMilestone(controller.getState(), milestone);
  if (!result.changed) {
    if (result.reason === 'invalid') {
      return invalidMilestoneMessage();
    }
    return unknownMilestoneMessage(String(milestone));
  }

  controller.replaceState(result.state);
  controller.persist();
  return `${NOTIFICATION_PREFIX}withdrew milestone "${String(milestone)}".`;
}

function judgeToolResult(controller: StateController): string {
  const result = judgeState(controller.getState());
  if (result.changed) {
    controller.replaceState(result.state);
    controller.persist();
  }
  return formatProgressVerdict(result.verdict);
}

export function registerAgentProgressTools(
  pi: ExtensionAPI,
  controller: StateController,
): void {
  pi.registerTool({
    name: 'agent_progress_get',
    label: 'Agent Progress: get',
    description:
      'Read the current caller-declared Agent Progress state as readable text. This reports what was recorded and does not infer, verify, or assert meaning, truth, progress, evidence, or completion.',
    parameters: GET_PARAMETERS,
    execute: async () => textResult(formatProgressState(controller.getState())),
  });

  pi.registerTool({
    name: 'agent_progress_add_milestone',
    label: 'Agent Progress: add milestone',
    description:
      'Add one caller-declared opaque milestone to the current Agent Progress set. This tool does not infer, verify, or assert the milestone meaning, truth, progress, evidence, or completion.',
    parameters: MILESTONE_PARAMETERS,
    execute: async (_id, params) => {
      try {
        return textResult(addToolResult(controller, params.milestone));
      } catch (error: unknown) {
        return textResult(formatProgressError(error));
      }
    },
  });

  pi.registerTool({
    name: 'agent_progress_withdraw_milestone',
    label: 'Agent Progress: withdraw milestone',
    description:
      'Withdraw one caller-declared opaque milestone from the current Agent Progress set. This changes only the declared set and does not infer, verify, or assert the milestone meaning, truth, progress, evidence, or completion.',
    parameters: MILESTONE_PARAMETERS,
    execute: async (_id, params) => {
      try {
        return textResult(withdrawToolResult(controller, params.milestone));
      } catch (error: unknown) {
        return textResult(formatProgressError(error));
      }
    },
  });

  pi.registerTool({
    name: 'agent_progress_judge',
    label: 'Agent Progress: judge',
    description:
      'Judge the complete currently declared milestone set supplied by the caller against the cumulative baseline with the Progress core. This reports whether the declared set strictly grew; it does not inspect milestone meaning or verify that a milestone was worth reaching, and does not infer, verify, or assert truth, evidence, or completion.',
    parameters: GET_PARAMETERS,
    execute: async () => {
      try {
        return textResult(judgeToolResult(controller));
      } catch (error: unknown) {
        return textResult(formatProgressError(error));
      }
    },
  });
}
