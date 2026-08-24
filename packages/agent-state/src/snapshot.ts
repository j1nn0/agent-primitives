import { AgentStateError } from './errors.js';
import { createAgentState } from './state.js';
import {
  copyDecision,
  copyWorkItem,
  duplicateDecision,
  duplicateWorkItem,
  hasOwn,
  invalidInput,
  isPlainObject,
  validateDecision,
  validateWorkItemSnapshot,
} from './item.js';
import type {
  AgentState,
  AgentStateInput,
  AgentStateSnapshot,
  AgentStateSummary,
  Decision,
  WorkItem,
} from './types.js';

interface ValidatedSnapshot {
  readonly objective?: string;
  readonly workItems: readonly WorkItem[];
  readonly decisions: readonly Decision[];
}

function validateSnapshot(value: unknown): ValidatedSnapshot {
  if (!isPlainObject(value)) {
    return invalidInput('Invalid agent state snapshot.');
  }

  try {
    if (!hasOwn(value, 'schemaVersion') || value.schemaVersion !== 1) {
      return invalidInput('Invalid agent state snapshot.');
    }

    const hasObjective = hasOwn(value, 'objective');
    const rawObjective = hasObjective ? value.objective : undefined;
    if (hasObjective && typeof rawObjective !== 'string') {
      return invalidInput('Invalid agent state snapshot.');
    }

    if (!hasOwn(value, 'workItems') || !Array.isArray(value.workItems)) {
      return invalidInput('Invalid agent state snapshot.');
    }
    if (!hasOwn(value, 'decisions') || !Array.isArray(value.decisions)) {
      return invalidInput('Invalid agent state snapshot.');
    }

    const workItems: WorkItem[] = [];
    const workItemIds = new Set<string>();
    for (const candidate of value.workItems) {
      const item = validateWorkItemSnapshot(candidate);
      if (workItemIds.has(item.id)) {
        return duplicateWorkItem(item.id);
      }
      workItemIds.add(item.id);
      workItems.push(item);
    }

    const decisions: Decision[] = [];
    const decisionIds = new Set<string>();
    for (const candidate of value.decisions) {
      const decision = validateDecision(candidate, true);
      if (decisionIds.has(decision.id)) {
        return duplicateDecision(decision.id);
      }
      decisionIds.add(decision.id);
      decisions.push(decision);
    }

    if (rawObjective === undefined) {
      return { workItems, decisions };
    }
    if (typeof rawObjective !== 'string') {
      return invalidInput('Invalid agent state snapshot.');
    }
    return { objective: rawObjective, workItems, decisions };
  } catch (error) {
    if (error instanceof AgentStateError) {
      throw error;
    }
    return invalidInput('Invalid agent state snapshot.');
  }
}

export function restoreAgentState(snapshot: unknown): AgentState {
  const validated = validateSnapshot(snapshot);
  const input: AgentStateInput = {
    workItems: validated.workItems.map(copyWorkItem),
    decisions: validated.decisions.map(copyDecision),
  };
  if (validated.objective !== undefined) {
    input.objective = validated.objective;
  }
  return createAgentState(input);
}

export function summarizeAgentState(
  snapshot: AgentStateSnapshot,
): AgentStateSummary {
  const summary = {
    open: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
    total: 0,
  };

  for (const item of snapshot.workItems) {
    switch (item.status) {
      case 'open':
        summary.open += 1;
        break;
      case 'in_progress':
        summary.in_progress += 1;
        break;
      case 'blocked':
        summary.blocked += 1;
        break;
      case 'done':
        summary.done += 1;
        break;
    }
    summary.total += 1;
  }

  return summary;
}
