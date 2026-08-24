import {
  copyDecision,
  copyWorkItem,
  duplicateDecision,
  duplicateWorkItem,
  hasOwn,
  invalidInput,
  isPlainObject,
  unknownWorkItem,
  validateDecision,
  validateWorkItemInput,
} from './item.js';
import { AgentStateError } from './errors.js';
import type {
  AgentState,
  AgentStateInput,
  AgentStateSnapshot,
  Decision,
  WorkItem,
} from './types.js';

interface ValidatedAgentStateInput {
  readonly objective?: string;
  readonly workItems: readonly WorkItem[];
  readonly decisions: readonly Decision[];
}

function validateAgentStateInput(value: unknown): ValidatedAgentStateInput {
  if (value === undefined) {
    return { workItems: [], decisions: [] };
  }
  if (!isPlainObject(value)) {
    return invalidInput();
  }

  try {
    let objective: string | undefined;
    if (hasOwn(value, 'objective')) {
      const rawObjective = value.objective;
      if (rawObjective !== undefined && typeof rawObjective !== 'string') {
        return invalidInput();
      }
      objective = rawObjective;
    }

    const rawWorkItems = hasOwn(value, 'workItems') ? value.workItems : undefined;
    if (rawWorkItems !== undefined && !Array.isArray(rawWorkItems)) {
      return invalidInput();
    }

    const rawDecisions = hasOwn(value, 'decisions') ? value.decisions : undefined;
    if (rawDecisions !== undefined && !Array.isArray(rawDecisions)) {
      return invalidInput();
    }

    const workItems: WorkItem[] = [];
    const workItemIds = new Set<string>();
    for (const candidate of rawWorkItems ?? []) {
      const item = validateWorkItemInput(candidate);
      if (workItemIds.has(item.id)) {
        return duplicateWorkItem(item.id);
      }
      workItemIds.add(item.id);
      workItems.push(item);
    }

    const decisions: Decision[] = [];
    const decisionIds = new Set<string>();
    for (const candidate of rawDecisions ?? []) {
      const decision = validateDecision(candidate);
      if (decisionIds.has(decision.id)) {
        return duplicateDecision(decision.id);
      }
      decisionIds.add(decision.id);
      decisions.push(decision);
    }

    if (objective === undefined) {
      return { workItems, decisions };
    }
    return { objective, workItems, decisions };
  } catch (error) {
    if (error instanceof AgentStateError) {
      throw error;
    }
    return invalidInput();
  }
}

export function createAgentState(input?: AgentStateInput): AgentState {
  const validated = validateAgentStateInput(input);
  const objective = validated.objective;
  const workItems = new Map<string, WorkItem>();
  const decisions = new Map<string, Decision>();

  for (const item of validated.workItems) {
    workItems.set(item.id, item);
  }
  for (const decision of validated.decisions) {
    decisions.set(decision.id, decision);
  }

  const state: AgentState = {
    addWorkItem(item): WorkItem {
      const validatedItem = validateWorkItemInput(item);
      if (workItems.has(validatedItem.id)) {
        return duplicateWorkItem(validatedItem.id);
      }
      workItems.set(validatedItem.id, validatedItem);
      return copyWorkItem(validatedItem);
    },

    setWorkItemStatus(id, status): WorkItem {
      if (typeof id !== 'string' || id.trim().length === 0) {
        return invalidInput();
      }
      if (
        status !== 'open' &&
        status !== 'in_progress' &&
        status !== 'blocked' &&
        status !== 'done'
      ) {
        return invalidInput();
      }

      const existing = workItems.get(id);
      if (existing === undefined) {
        return unknownWorkItem(id);
      }
      const updated: WorkItem = {
        id: existing.id,
        content: existing.content,
        status,
      };
      workItems.set(id, updated);
      return copyWorkItem(updated);
    },

    getWorkItem(id): WorkItem | undefined {
      const item = workItems.get(id);
      return item === undefined ? undefined : copyWorkItem(item);
    },

    listWorkItems(): readonly WorkItem[] {
      return Array.from(workItems.values(), copyWorkItem);
    },

    removeWorkItem(id): boolean {
      return workItems.delete(id);
    },

    addDecision(decision): Decision {
      const validatedDecision = validateDecision(decision);
      if (decisions.has(validatedDecision.id)) {
        return duplicateDecision(validatedDecision.id);
      }
      decisions.set(validatedDecision.id, validatedDecision);
      return copyDecision(validatedDecision);
    },

    listDecisions(): readonly Decision[] {
      return Array.from(decisions.values(), copyDecision);
    },

    snapshot(): AgentStateSnapshot {
      const base = {
        schemaVersion: 1 as const,
        workItems: Array.from(workItems.values(), copyWorkItem),
        decisions: Array.from(decisions.values(), copyDecision),
      };
      if (objective === undefined) {
        return base;
      }
      return { ...base, objective };
    },
  };

  return state;
}
