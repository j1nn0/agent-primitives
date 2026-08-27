import { createHandoff, type HandoffPacket } from '@j1nn0/agent-handoff';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export const STATE_CUSTOM_TYPE = 'agent-handoff-state' as const;
export const ADAPTER_SCHEMA_VERSION = 1 as const;

export interface HandoffState {
  readonly packets: readonly HandoffPacket[];
}

export interface PersistedState {
  readonly schemaVersion: 1;
  readonly packets: readonly HandoffPacket[];
}

export interface StateController {
  readonly getState: () => HandoffState;
  readonly replaceState: (state: HandoffState) => void;
  readonly persist: () => void;
}

export type StateMutationResult =
  | { readonly changed: true; readonly state: HandoffState }
  | { readonly changed: false; readonly reason: 'invalid' | 'not_found' | 'no_change' | 'duplicate' };

export type CreatePacketResult = StateMutationResult;
export type RemovePacketResult = StateMutationResult;
export type ClearStateResult = StateMutationResult;

const INVALID_STATE_WARNING =
  'Agent Handoff: persisted state was invalid; starting with fresh state.';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
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

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function isValidIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function copyPacket(packet: HandoffPacket): HandoffPacket {
  return {
    schemaVersion: packet.schemaVersion,
    id: packet.id,
    source: packet.source,
    ...(packet.destination === undefined ? {} : { destination: packet.destination }),
    goal: packet.goal,
    ...(packet.constraints === undefined ? {} : { constraints: [...packet.constraints] }),
    ...(packet.openItems === undefined ? {} : { openItems: [...packet.openItems] }),
    ...(packet.evidenceReferences === undefined
      ? {}
      : { evidenceReferences: [...packet.evidenceReferences] }),
  };
}

function parsePersistedState(value: unknown): HandoffState | undefined {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ['schemaVersion', 'packets']) ||
    !hasOwn(value, 'schemaVersion') ||
    value.schemaVersion !== ADAPTER_SCHEMA_VERSION ||
    !hasOwn(value, 'packets') ||
    !Array.isArray(value.packets)
  ) {
    return undefined;
  }

  const packets: HandoffPacket[] = [];
  const seenIds = new Set<string>();

  for (const raw of value.packets) {
    let validated: HandoffPacket;
    try {
      validated = createHandoff(raw);
    } catch {
      return undefined;
    }

    if (seenIds.has(validated.id)) {
      return undefined;
    }
    seenIds.add(validated.id);
    packets.push(copyPacket(validated));
  }

  return { packets };
}

export function createEmptyState(): HandoffState {
  return { packets: [] };
}

export function loadState(ctx: Pick<ExtensionContext, 'sessionManager' | 'ui'>): HandoffState {
  try {
    const latestStateEntry = ctx.sessionManager
      .getBranch()
      .filter((entry) => entry.type === 'custom' && entry.customType === STATE_CUSTOM_TYPE)
      .at(-1);

    if (latestStateEntry === undefined || latestStateEntry.type !== 'custom') {
      return createEmptyState();
    }

    const state = parsePersistedState(latestStateEntry.data);
    if (state === undefined) {
      ctx.ui.notify(INVALID_STATE_WARNING, 'warning');
      return createEmptyState();
    }

    return state;
  } catch {
    ctx.ui.notify(INVALID_STATE_WARNING, 'warning');
    return createEmptyState();
  }
}

export function saveState(pi: Pick<ExtensionAPI, 'appendEntry'>, state: HandoffState): void {
  const payload: PersistedState = {
    schemaVersion: ADAPTER_SCHEMA_VERSION,
    packets: state.packets.map(copyPacket),
  };
  pi.appendEntry(STATE_CUSTOM_TYPE, payload);
}

export function isFreshState(state: HandoffState): boolean {
  return state.packets.length === 0;
}

export function createPacket(state: HandoffState, raw: unknown): CreatePacketResult {
  let validated: HandoffPacket;
  try {
    validated = createHandoff(raw);
  } catch {
    return { changed: false, reason: 'invalid' };
  }

  if (state.packets.some((packet) => packet.id === validated.id)) {
    return { changed: false, reason: 'duplicate' };
  }

  return {
    changed: true,
    state: {
      packets: [...state.packets.map(copyPacket), copyPacket(validated)],
    },
  };
}

export function removePacket(state: HandoffState, id: unknown): RemovePacketResult {
  if (!isValidIdentifier(id)) {
    return { changed: false, reason: 'invalid' };
  }

  const index = state.packets.findIndex((packet) => packet.id === id);
  if (index < 0) {
    return { changed: false, reason: 'not_found' };
  }

  return {
    changed: true,
    state: {
      packets: state.packets.filter((_, i) => i !== index),
    },
  };
}

export function clearState(state: HandoffState): ClearStateResult {
  if (isFreshState(state)) {
    return { changed: false, reason: 'no_change' };
  }

  return { changed: true, state: createEmptyState() };
}

export { isPlainRecord, hasOwn, hasOnlyKeys };
