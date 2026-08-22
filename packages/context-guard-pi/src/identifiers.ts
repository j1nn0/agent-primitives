import { createHash } from 'node:crypto';
import type { ContextItemKind } from '@j1nn0/agent-context-guard';

export function digest12(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function automaticItemId(
  kind: ContextItemKind,
  content: string,
): string {
  return `auto:${kind}:${digest12(`${kind} ${content}`)}`;
}

export function discoveryItemId(
  kind: ContextItemKind,
  content: string,
): string {
  return `discovery:${kind}:${digest12(`${kind} ${content}`)}`;
}

export function probeId(
  baseId: string,
  occupiedIds: Set<string>,
): string {
  let id = baseId;
  let probe = 2;
  while (occupiedIds.has(id)) {
    id = `${baseId}-${probe}`;
    probe += 1;
  }
  return id;
}
