import { createContextGuard } from '@j1nn0/agent-context-guard';
import type { ContextItemInput } from '@j1nn0/agent-context-guard';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type {
  DiscoveryMode,
  DiscoveryProvenance,
  PersistedState,
  PersistedStateV1,
  PersistedStateV2,
  PersistedStateV3,
  PersistedStateV4,
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
  data: PersistedStateV3 | PersistedStateV4,
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
    if (isPersistedStateV4Shape(data) || isPersistedStateV3Shape(data)) {
      const guard = createContextGuard(
        data.items as readonly ContextItemInput[],
      );
      const autoItemIds = new Set<string>(
        data.autoItemIds.filter((id) => guard.has(id)),
      );
      return {
        guard,
        recovery: data.recovery,
        extraction: data.extraction,
        discovery: data.discovery,
        autoItemIds,
        discoveryItemIds: new Set<string>(
          data.discoveryItemIds.filter((id) => guard.has(id)),
        ),
        discoveryProvenance: discoveryProvenanceForState(data, guard),
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

  const payload: PersistedState = {
    schemaVersion: 4,
    recovery: state.recovery,
    extraction: state.extraction,
    discovery: state.discovery,
    items: state.guard.list(),
    autoItemIds: Array.from(state.autoItemIds).filter((id) => state.guard.has(id)),
    discoveryItemIds,
    discoveryProvenance,
  };
  pi.appendEntry(STATE_CUSTOM_TYPE, payload);
  state.degraded = false;
}
