import { ContextGuardError } from './errors.js';
import type { ContextItem, ContextItemKind } from './types.js';

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

function isContextItemKind(value: unknown): value is ContextItemKind {
  return (
    value === 'goal' ||
    value === 'constraint' ||
    value === 'requirement' ||
    value === 'decision' ||
    value === 'fact'
  );
}

export function invalidContextItem(): never {
  throw new ContextGuardError('invalid_input', 'Invalid context item.');
}

export function duplicateItem(id: string): never {
  throw new ContextGuardError(
    'duplicate_item_id',
    `Duplicate context item id "${id}".`,
    id,
  );
}

export function validateContextItem(value: unknown): ContextItem {
  if (!isPlainObject(value)) {
    return invalidContextItem();
  }

  const id = value.id;
  if (typeof id !== 'string' || id.trim().length === 0) {
    return invalidContextItem();
  }

  const kind = value.kind;
  if (!isContextItemKind(kind)) {
    return invalidContextItem();
  }

  const content = value.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    return invalidContextItem();
  }

  const hasCritical = hasOwn(value, 'critical');
  const criticalValue = value.critical;
  let critical = false;
  if (hasCritical) {
    if (typeof criticalValue !== 'boolean') {
      return invalidContextItem();
    }
    critical = criticalValue;
  }

  return { id, kind, content, critical };
}

export function copyItem(item: ContextItem): ContextItem {
  return {
    id: item.id,
    kind: item.kind,
    content: item.content,
    critical: item.critical,
  };
}
