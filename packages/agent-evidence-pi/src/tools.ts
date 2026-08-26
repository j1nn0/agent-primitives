import {
  type AgentToolResult,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import type { EvidenceOutcome } from '@j1nn0/agent-evidence';
import { formatEvidenceState, formatEvidenceVerdict } from './display.js';
import {
  formatEvidenceError,
  invalidMutationMessage,
  invalidToolParametersMessage,
  NOTIFICATION_PREFIX,
} from './messages.js';
import {
  addClaim,
  addEvidence,
  hasOwn,
  hasOnlyKeys,
  isEvidenceOutcome,
  isPlainRecord,
  judgeState,
  removeClaim,
  removeEvidence,
  replaceEvidence,
  type StateController,
} from './state.js';

export const TOOL_NAMES = [
  'agent_evidence_get',
  'agent_evidence_add_claim',
  'agent_evidence_remove_claim',
  'agent_evidence_add_evidence',
  'agent_evidence_replace_evidence',
  'agent_evidence_remove_evidence',
  'agent_evidence_judge',
] as const;

const GET_PARAMETERS = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

const ADD_CLAIM_PARAMETERS = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: 'Caller-supplied opaque claim identifier, preserved exactly.',
    },
    requires: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          evidenceId: {
            type: 'string',
            description:
              'Caller-supplied opaque evidence identifier required by this claim.',
          },
          subject: {
            type: 'string',
            description:
              'Optional caller-supplied opaque subject, matched exactly when judging.',
          },
        },
        required: ['evidenceId'],
        additionalProperties: false,
      },
    },
  },
  required: ['id', 'requires'],
  additionalProperties: false,
} as const;

const REMOVE_CLAIM_PARAMETERS = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: 'Caller-supplied claim identifier to remove.',
    },
  },
  required: ['id'],
  additionalProperties: false,
} as const;

const EVIDENCE_PARAMETERS = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: 'Caller-supplied opaque evidence identifier, preserved exactly.',
    },
    outcome: {
      type: 'string',
      enum: ['confirmed', 'refuted', 'unknown'],
      description: 'Exact caller-declared evidence outcome.',
    },
    subject: {
      type: 'string',
      description:
        'Optional caller-supplied opaque subject, matched exactly when judging.',
    },
  },
  required: ['id', 'outcome'],
  additionalProperties: false,
} as const;

const REMOVE_EVIDENCE_PARAMETERS = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: 'Caller-supplied evidence identifier to remove.',
    },
  },
  required: ['id'],
  additionalProperties: false,
} as const;

type TextToolResult = AgentToolResult<undefined>;

type ParsedClaim = {
  readonly id: string;
  readonly requires: readonly unknown[];
};

type ParsedEvidence = {
  readonly id: string;
  readonly outcome: EvidenceOutcome;
  readonly subject?: string;
};

const NO_AUTOMATIC_WORK =
  ' The adapter does not collect evidence automatically, execute commands, generate claims or subjects, judge automatically, map to other primitives, or verify truth.';

function textResult(text: string): TextToolResult {
  return {
    content: [{ type: 'text' as const, text }],
    details: undefined,
  };
}

function hasNoParameters(value: unknown): boolean {
  return isPlainRecord(value) && Object.keys(value).length === 0;
}

function parseClaimParameters(value: unknown): ParsedClaim | undefined {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ['id', 'requires']) ||
    !hasOwn(value, 'id') ||
    typeof value.id !== 'string' ||
    !hasOwn(value, 'requires') ||
    !Array.isArray(value.requires)
  ) {
    return undefined;
  }

  for (const requirement of value.requires) {
    if (
      !isPlainRecord(requirement) ||
      !hasOnlyKeys(requirement, ['evidenceId', 'subject']) ||
      !hasOwn(requirement, 'evidenceId') ||
      typeof requirement.evidenceId !== 'string'
    ) {
      return undefined;
    }
    if (
      hasOwn(requirement, 'subject') &&
      typeof requirement.subject !== 'string'
    ) {
      return undefined;
    }
  }

  return { id: value.id, requires: value.requires };
}

function parseEvidenceParameters(value: unknown): ParsedEvidence | undefined {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ['id', 'outcome', 'subject']) ||
    !hasOwn(value, 'id') ||
    typeof value.id !== 'string' ||
    !hasOwn(value, 'outcome') ||
    !isEvidenceOutcome(value.outcome)
  ) {
    return undefined;
  }

  if (hasOwn(value, 'subject')) {
    return typeof value.subject === 'string'
      ? { id: value.id, outcome: value.outcome, subject: value.subject }
      : undefined;
  }

  return { id: value.id, outcome: value.outcome };
}

function parseIdParameters(value: unknown): { readonly id: string } | undefined {
  return isPlainRecord(value) &&
    hasOnlyKeys(value, ['id']) &&
    hasOwn(value, 'id') &&
    typeof value.id === 'string'
    ? { id: value.id }
    : undefined;
}

function addClaimToolResult(
  controller: StateController,
  params: unknown,
): string {
  const parsed = parseClaimParameters(params);
  if (parsed === undefined) {
    return invalidToolParametersMessage();
  }

  const result = addClaim(controller.getState(), parsed);
  if (!result.changed) {
    return invalidMutationMessage();
  }

  controller.replaceState(result.state);
  controller.persist();
  return `${NOTIFICATION_PREFIX}recorded claim "${parsed.id}"; ${result.state.claims.length} ${result.state.claims.length === 1 ? 'claim' : 'claims'} in the current session.`;
}

function removeClaimToolResult(
  controller: StateController,
  params: unknown,
): string {
  const parsed = parseIdParameters(params);
  if (parsed === undefined) {
    return invalidToolParametersMessage();
  }

  const result = removeClaim(controller.getState(), parsed.id);
  if (!result.changed) {
    return result.reason === 'not_found'
      ? `${NOTIFICATION_PREFIX}unknown claim "${parsed.id}"; state was unchanged.`
      : invalidMutationMessage();
  }

  controller.replaceState(result.state);
  controller.persist();
  return `${NOTIFICATION_PREFIX}removed claim "${parsed.id}"; ${result.state.claims.length} ${result.state.claims.length === 1 ? 'claim' : 'claims'} remain in the current session.`;
}

function addEvidenceToolResult(
  controller: StateController,
  params: unknown,
): string {
  const parsed = parseEvidenceParameters(params);
  if (parsed === undefined) {
    return invalidToolParametersMessage();
  }

  const result = addEvidence(controller.getState(), parsed);
  if (!result.changed) {
    return invalidMutationMessage();
  }

  controller.replaceState(result.state);
  controller.persist();
  return `${NOTIFICATION_PREFIX}recorded evidence "${parsed.id}" with outcome=${parsed.outcome}; ${result.state.evidence.length} ${result.state.evidence.length === 1 ? 'record' : 'records'} in the current session.`;
}

function replaceEvidenceToolResult(
  controller: StateController,
  params: unknown,
): string {
  const parsed = parseEvidenceParameters(params);
  if (parsed === undefined) {
    return invalidToolParametersMessage();
  }

  const result = replaceEvidence(controller.getState(), parsed);
  if (!result.changed) {
    return result.reason === 'not_found'
      ? `${NOTIFICATION_PREFIX}unknown evidence "${parsed.id}"; state was unchanged.`
      : invalidMutationMessage();
  }

  controller.replaceState(result.state);
  controller.persist();
  return `${NOTIFICATION_PREFIX}replaced evidence "${parsed.id}" with outcome=${parsed.outcome}.`;
}

function removeEvidenceToolResult(
  controller: StateController,
  params: unknown,
): string {
  const parsed = parseIdParameters(params);
  if (parsed === undefined) {
    return invalidToolParametersMessage();
  }

  const result = removeEvidence(controller.getState(), parsed.id);
  if (!result.changed) {
    return result.reason === 'not_found'
      ? `${NOTIFICATION_PREFIX}unknown evidence "${parsed.id}"; state was unchanged.`
      : invalidMutationMessage();
  }

  controller.replaceState(result.state);
  controller.persist();
  return `${NOTIFICATION_PREFIX}removed evidence "${parsed.id}"; ${result.state.evidence.length} ${result.state.evidence.length === 1 ? 'record' : 'records'} remain in the current session.`;
}

export function registerAgentEvidenceTools(
  pi: ExtensionAPI,
  controller: StateController,
): void {
  pi.registerTool({
    name: 'agent_evidence_get',
    label: 'Agent Evidence: get',
    description:
      'Read the current caller-declared claims and evidence as a raw, non-judging summary.' +
      NO_AUTOMATIC_WORK,
    parameters: GET_PARAMETERS,
    execute: async (_id, params) =>
      hasNoParameters(params)
        ? textResult(formatEvidenceState(controller.getState()))
        : textResult(invalidToolParametersMessage()),
  });

  pi.registerTool({
    name: 'agent_evidence_add_claim',
    label: 'Agent Evidence: add claim',
    description:
      'Record one caller-declared claim and its required evidence identifiers. The candidate state is revalidated by the Evidence core before it is persisted.' +
      NO_AUTOMATIC_WORK,
    parameters: ADD_CLAIM_PARAMETERS,
    execute: async (_id, params) => {
      try {
        return textResult(addClaimToolResult(controller, params));
      } catch (error: unknown) {
        return textResult(formatEvidenceError(error));
      }
    },
  });

  pi.registerTool({
    name: 'agent_evidence_remove_claim',
    label: 'Agent Evidence: remove claim',
    description:
      'Remove one caller-declared claim by identifier. The candidate state is revalidated by the Evidence core before it is persisted.' +
      NO_AUTOMATIC_WORK,
    parameters: REMOVE_CLAIM_PARAMETERS,
    execute: async (_id, params) => {
      try {
        return textResult(removeClaimToolResult(controller, params));
      } catch (error: unknown) {
        return textResult(formatEvidenceError(error));
      }
    },
  });

  pi.registerTool({
    name: 'agent_evidence_add_evidence',
    label: 'Agent Evidence: add evidence',
    description:
      'Record one caller-declared evidence record with an exact outcome and optional subject. The candidate state is revalidated by the Evidence core before it is persisted.' +
      NO_AUTOMATIC_WORK,
    parameters: EVIDENCE_PARAMETERS,
    execute: async (_id, params) => {
      try {
        return textResult(addEvidenceToolResult(controller, params));
      } catch (error: unknown) {
        return textResult(formatEvidenceError(error));
      }
    },
  });

  pi.registerTool({
    name: 'agent_evidence_replace_evidence',
    label: 'Agent Evidence: replace evidence',
    description:
      'Replace one existing caller-declared evidence record wholesale; omitting subject clears it. The candidate state is revalidated by the Evidence core before it is persisted.' +
      NO_AUTOMATIC_WORK,
    parameters: EVIDENCE_PARAMETERS,
    execute: async (_id, params) => {
      try {
        return textResult(replaceEvidenceToolResult(controller, params));
      } catch (error: unknown) {
        return textResult(formatEvidenceError(error));
      }
    },
  });

  pi.registerTool({
    name: 'agent_evidence_remove_evidence',
    label: 'Agent Evidence: remove evidence',
    description:
      'Remove one caller-declared evidence record by identifier. The candidate state is revalidated by the Evidence core before it is persisted.' +
      NO_AUTOMATIC_WORK,
    parameters: REMOVE_EVIDENCE_PARAMETERS,
    execute: async (_id, params) => {
      try {
        return textResult(removeEvidenceToolResult(controller, params));
      } catch (error: unknown) {
        return textResult(formatEvidenceError(error));
      }
    },
  });

  pi.registerTool({
    name: 'agent_evidence_judge',
    label: 'Agent Evidence: judge',
    description:
      'Explicitly judge the current caller-declared claims and evidence by delegating to the Evidence core. Judgment happens only when this tool is explicitly called.' +
      NO_AUTOMATIC_WORK,
    parameters: GET_PARAMETERS,
    execute: async (_id, params) => {
      if (!hasNoParameters(params)) {
        return textResult(invalidToolParametersMessage());
      }
      try {
        return textResult(formatEvidenceVerdict(judgeState(controller.getState())));
      } catch (error: unknown) {
        return textResult(formatEvidenceError(error));
      }
    },
  });
}
