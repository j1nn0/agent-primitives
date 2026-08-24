import { AgentStateError } from './errors.js';
import type { Decision, WorkItem, WorkItemStatus } from './types.js';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
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

export function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isWorkItemStatus(value: unknown): value is WorkItemStatus {
  return (
    value === 'open' ||
    value === 'in_progress' ||
    value === 'blocked' ||
    value === 'done'
  );
}

export function invalidInput(message = 'Invalid agent state input.'): never {
  throw new AgentStateError('invalid_input', message);
}

export function duplicateWorkItem(id: string): never {
  throw new AgentStateError(
    'duplicate_item_id',
    `Duplicate work item id "${id}".`,
    id,
  );
}

export function duplicateDecision(id: string): never {
  throw new AgentStateError(
    'duplicate_item_id',
    `Duplicate decision id "${id}".`,
    id,
  );
}

export function unknownWorkItem(id: string): never {
  throw new AgentStateError('unknown_item_id', `Unknown work item id "${id}".`, id);
}

export function validateWorkItemInput(value: unknown): WorkItem {
  if (!isPlainObject(value)) {
    return invalidInput();
  }

  try {
    if (!hasOwn(value, 'id') || !hasOwn(value, 'content')) {
      return invalidInput();
    }

    const id = value.id;
    const content = value.content;
    if (
      typeof id !== 'string' ||
      id.trim().length === 0 ||
      typeof content !== 'string' ||
      content.trim().length === 0
    ) {
      return invalidInput();
    }

    const status = hasOwn(value, 'status') ? value.status : undefined;
    if (status !== undefined && !isWorkItemStatus(status)) {
      return invalidInput();
    }

    return {
      id,
      content,
      status: status ?? 'open',
    };
  } catch (error) {
    if (error instanceof AgentStateError) {
      throw error;
    }
    return invalidInput();
  }
}

export function validateWorkItemSnapshot(value: unknown): WorkItem {
  if (!isPlainObject(value)) {
    return invalidInput('Invalid agent state snapshot.');
  }

  try {
    if (
      !hasOwn(value, 'id') ||
      !hasOwn(value, 'content') ||
      !hasOwn(value, 'status')
    ) {
      return invalidInput('Invalid agent state snapshot.');
    }

    const id = value.id;
    const content = value.content;
    const status = value.status;
    if (
      typeof id !== 'string' ||
      id.trim().length === 0 ||
      typeof content !== 'string' ||
      content.trim().length === 0 ||
      !isWorkItemStatus(status)
    ) {
      return invalidInput('Invalid agent state snapshot.');
    }

    return { id, content, status };
  } catch (error) {
    if (error instanceof AgentStateError) {
      throw error;
    }
    return invalidInput('Invalid agent state snapshot.');
  }
}

export function validateDecision(value: unknown, snapshot = false): Decision {
  if (!isPlainObject(value)) {
    return invalidInput(snapshot ? 'Invalid agent state snapshot.' : undefined);
  }

  try {
    if (!hasOwn(value, 'id') || !hasOwn(value, 'content')) {
      return invalidInput(snapshot ? 'Invalid agent state snapshot.' : undefined);
    }

    const id = value.id;
    const content = value.content;
    if (
      typeof id !== 'string' ||
      id.trim().length === 0 ||
      typeof content !== 'string' ||
      content.trim().length === 0
    ) {
      return invalidInput(snapshot ? 'Invalid agent state snapshot.' : undefined);
    }

    return { id, content };
  } catch (error) {
    if (error instanceof AgentStateError) {
      throw error;
    }
    return invalidInput(snapshot ? 'Invalid agent state snapshot.' : undefined);
  }
}

export function copyWorkItem(item: WorkItem): WorkItem {
  return {
    id: item.id,
    content: item.content,
    status: item.status,
  };
}

export function copyDecision(decision: Decision): Decision {
  return {
    id: decision.id,
    content: decision.content,
  };
}
