import { createContextGuard } from '@j1nn0/agent-context-guard';
import type { ContextItemInput } from '@j1nn0/agent-context-guard';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { copyDiscoveryLifecycle, createDiscoveryLifecycle } from './discovery-lifecycle.js';
import type {
  DiscoveryLifecycle,
  DiscoveryMode,
  DiscoveryProvenance,
  PersistedState,
  PersistedStateV1,
  PersistedStateV2,
  PersistedStateV3,
  PersistedStateV4,
  PersistedStateV5,
  RecoveryMode,
  RuntimeState,
} from './types.js';

export const STATE_CUSTOM_TYPE = 'agent-context-guard-state';

const INVALID_STATE_WARNING =
  'Context Guard: persisted state was invalid and has been discarded.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecoveryMode(value: unknown): value is RecoveryMode {
  return value === 'off' || value === 'critical';
}

function isExtractionMode(value: unknown): value is RuntimeState['extraction'] {
  return value === 'off' || value === 'automatic';
}

function isDiscoveryMode(value: unknown): value is DiscoveryMode {
  return value === 'off' || value === 'automatic';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isDiscoveryEvidenceSpan(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.startOffset === 'number' &&
    typeof value.endOffset === 'number' &&
    Number.isInteger(value.startOffset) &&
    Number.isInteger(value.endOffset) &&
    value.startOffset >= 0 &&
    value.endOffset > value.startOffset
  );
}

function isDiscoveryProvenanceReference(
  value: unknown,
): value is DiscoveryProvenance {
  return (
    isRecord(value) &&
    typeof value.toolCallId === 'string' &&
    typeof value.toolName === 'string' &&
    typeof value.quoteHash === 'string' &&
    (!Object.prototype.hasOwnProperty.call(value, 'span') ||
      isDiscoveryEvidenceSpan(value.span))
  );
}

function isDiscoveryProvenance(
  value: unknown,
): value is Readonly<Record<string, readonly DiscoveryProvenance[]>> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (references) =>
        Array.isArray(references) &&
        references.every(isDiscoveryProvenanceReference),
    )
  );
}

function isPersistedStateV1Shape(value: unknown): value is PersistedStateV1 {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    isRecoveryMode(value.recovery) &&
    Array.isArray(value.items)
  );
}

function isPersistedStateV2Shape(value: unknown): value is PersistedStateV2 {
  return (
    isRecord(value) &&
    value.schemaVersion === 2 &&
    isRecoveryMode(value.recovery) &&
    isExtractionMode(value.extraction) &&
    Array.isArray(value.items) &&
    isStringArray(value.autoItemIds)
  );
}

function isPersistedStateV3Shape(value: unknown): value is PersistedStateV3 {
  return (
    isRecord(value) &&
    value.schemaVersion === 3 &&
    isRecoveryMode(value.recovery) &&
    isExtractionMode(value.extraction) &&
    isDiscoveryMode(value.discovery) &&
    Array.isArray(value.items) &&
    isStringArray(value.autoItemIds) &&
    isStringArray(value.discoveryItemIds) &&
    isDiscoveryProvenance(value.discoveryProvenance)
  );
}

function isDiscoveryLifecycleRecord(
  value: unknown,
): value is DiscoveryLifecycle {
  return (
    isRecord(value) &&
    (value.status === 'active' ||
      value.status === 'superseded' ||
      value.status === 'retired') &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    (!Object.prototype.hasOwnProperty.call(value, 'supersededBy') ||
      typeof value.supersededBy === 'string')
  );
}

function isDiscoveryLifecycle(
  value: unknown,
): value is Readonly<Record<string, DiscoveryLifecycle>> {
  return isRecord(value) && Object.values(value).every(isDiscoveryLifecycleRecord);
}

function isPersistedStateV4Shape(value: unknown): value is PersistedStateV4 {
  return (
    isRecord(value) &&
    value.schemaVersion === 4 &&
    isRecoveryMode(value.recovery) &&
    isExtractionMode(value.extraction) &&
    isDiscoveryMode(value.discovery) &&
    Array.isArray(value.items) &&
    isStringArray(value.autoItemIds) &&
    isStringArray(value.discoveryItemIds) &&
    isDiscoveryProvenance(value.discoveryProvenance)
  );
}

function isPersistedStateV5Shape(value: unknown): value is PersistedStateV5 {
  return (
    isRecord(value) &&
    value.schemaVersion === 5 &&
    isRecoveryMode(value.recovery) &&
    isExtractionMode(value.extraction) &&
    isDiscoveryMode(value.discovery) &&
    Array.isArray(value.items) &&
    isStringArray(value.autoItemIds) &&
    isStringArray(value.discoveryItemIds) &&
    isDiscoveryProvenance(value.discoveryProvenance) &&
    isDiscoveryLifecycle(value.discoveryLifecycle)
  );
}

function emptyDiscoveryLifecycle(): Map<string, DiscoveryLifecycle> {
  return new Map<string, DiscoveryLifecycle>();
}

/**
 * Restores lifecycle records for the discoveries still present in the guard.
 * State written before schema v5 carries no lifecycle at all, so every
 * discovery it holds comes back active: an older session must not lose
 * recovery for facts nobody retired.
 */
function discoveryLifecycleForState(
  data: PersistedStateV3 | PersistedStateV4 | PersistedStateV5,
  discoveryItemIds: ReadonlySet<string>,
): Map<string, DiscoveryLifecycle> {
  const lifecycle = emptyDiscoveryLifecycle();
  const persisted =
    'discoveryLifecycle' in data ? data.discoveryLifecycle : undefined;
  for (const id of discoveryItemIds) {
    const record = persisted?.[id];
    lifecycle.set(
      id,
      record === undefined
        ? createDiscoveryLifecycle()
        : copyDiscoveryLifecycle(record),
    );
  }
  return lifecycle;
}

function emptyDiscoveryProvenance(): Map<
  string,
  readonly DiscoveryProvenance[]
> {
  return new Map<string, readonly DiscoveryProvenance[]>();
}

function copyDiscoveryProvenance(
  reference: DiscoveryProvenance,
): DiscoveryProvenance {
  if (reference.span === undefined) {
    return {
      toolCallId: reference.toolCallId,
      toolName: reference.toolName,
      quoteHash: reference.quoteHash,
    };
  }
  return {
    toolCallId: reference.toolCallId,
    toolName: reference.toolName,
    quoteHash: reference.quoteHash,
    span: { ...reference.span },
  };
}

function discoveryProvenanceForState(
  data: PersistedStateV3 | PersistedStateV4 | PersistedStateV5,
  guard: RuntimeState['guard'],
): Map<string, readonly DiscoveryProvenance[]> {
  const provenance = emptyDiscoveryProvenance();
  for (const [id, references] of Object.entries(data.discoveryProvenance)) {
    if (guard.has(id)) {
      provenance.set(id, references.map(copyDiscoveryProvenance));
    }
  }
  return provenance;
}

export function createEmptyState(): RuntimeState {
  return {
    guard: createContextGuard(),
    recovery: 'off',
    extraction: 'off',
    discovery: 'off',
    autoItemIds: new Set<string>(),
    discoveryItemIds: new Set<string>(),
    discoveryProvenance: emptyDiscoveryProvenance(),
    discoveryLifecycle: emptyDiscoveryLifecycle(),
    degraded: false,
    lastExtraction: undefined,
    lastDiscovery: undefined,
  };
}

export function loadState(
  ctx: Pick<ExtensionContext, 'sessionManager' | 'ui'>,
): RuntimeState {
  const entries = ctx.sessionManager.getBranch();
  const latestStateEntry = entries
    .filter(
      (entry) =>
        entry.type === 'custom' && entry.customType === STATE_CUSTOM_TYPE,
    )
    .at(-1);

  if (latestStateEntry === undefined || latestStateEntry.type !== 'custom') {
    return createEmptyState();
  }

  try {
    const data = latestStateEntry.data;
    if (
      isPersistedStateV5Shape(data) ||
      isPersistedStateV4Shape(data) ||
      isPersistedStateV3Shape(data)
    ) {
      const guard = createContextGuard(
        data.items as readonly ContextItemInput[],
      );
      const autoItemIds = new Set<string>(
        data.autoItemIds.filter((id) => guard.has(id)),
      );
      const discoveryItemIds = new Set<string>(
        data.discoveryItemIds.filter((id) => guard.has(id)),
      );
      return {
        guard,
        recovery: data.recovery,
        extraction: data.extraction,
        discovery: data.discovery,
        autoItemIds,
        discoveryItemIds,
        discoveryProvenance: discoveryProvenanceForState(data, guard),
        discoveryLifecycle: discoveryLifecycleForState(data, discoveryItemIds),
        degraded: false,
        lastExtraction: undefined,
        lastDiscovery: undefined,
      };
    }

    if (isPersistedStateV2Shape(data)) {
      const guard = createContextGuard(
        data.items as readonly ContextItemInput[],
      );
      return {
        guard,
        recovery: data.recovery,
        extraction: data.extraction,
        discovery: 'off',
        autoItemIds: new Set<string>(
          data.autoItemIds.filter((id) => guard.has(id)),
        ),
        discoveryItemIds: new Set<string>(),
        discoveryProvenance: emptyDiscoveryProvenance(),
        discoveryLifecycle: emptyDiscoveryLifecycle(),
        degraded: false,
        lastExtraction: undefined,
        lastDiscovery: undefined,
      };
    }

    if (isPersistedStateV1Shape(data)) {
      const guard = createContextGuard(
        data.items as readonly ContextItemInput[],
      );
      return {
        guard,
        recovery: data.recovery,
        extraction: 'off',
        discovery: 'off',
        autoItemIds: new Set<string>(),
        discoveryItemIds: new Set<string>(),
        discoveryProvenance: emptyDiscoveryProvenance(),
        discoveryLifecycle: emptyDiscoveryLifecycle(),
        degraded: false,
        lastExtraction: undefined,
        lastDiscovery: undefined,
      };
    }

    throw new Error('Invalid persisted state shape.');
  } catch {
    ctx.ui.notify(INVALID_STATE_WARNING, 'warning');
    return {
      ...createEmptyState(),
      degraded: true,
    };
  }
}

export function saveState(
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  state: RuntimeState,
): void {
  const discoveryItemIds = Array.from(state.discoveryItemIds).filter((id) =>
    state.guard.has(id),
  );
  const discoveryProvenance: Record<
    string,
    readonly DiscoveryProvenance[]
  > = {};
  for (const id of discoveryItemIds) {
    const references = state.discoveryProvenance.get(id);
    if (references !== undefined) {
      discoveryProvenance[id] = references.map(copyDiscoveryProvenance);
    }
  }

  const discoveryLifecycle: Record<string, DiscoveryLifecycle> = {};
  for (const id of discoveryItemIds) {
    const record = state.discoveryLifecycle.get(id);
    if (record !== undefined) {
      discoveryLifecycle[id] = copyDiscoveryLifecycle(record);
    }
  }

  const payload: PersistedState = {
    schemaVersion: 5,
    recovery: state.recovery,
    extraction: state.extraction,
    discovery: state.discovery,
    items: state.guard.list(),
    autoItemIds: Array.from(state.autoItemIds).filter((id) => state.guard.has(id)),
    discoveryItemIds,
    discoveryProvenance,
    discoveryLifecycle,
  };
  pi.appendEntry(STATE_CUSTOM_TYPE, payload);
  state.degraded = false;
}
