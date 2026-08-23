import type {
  ContextGuard,
  ContextItem,
  VerificationReport,
} from '@j1nn0/agent-context-guard';

/** Controls whether lost critical items are injected after verification. */
export type RecoveryMode = 'off' | 'critical';

/** Controls whether protected items are extracted from user messages. */
export type ExtractionMode = 'off' | 'automatic';

/** Controls whether durable facts are captured from tool evidence. */
export type DiscoveryMode = 'off' | 'automatic';

export type RequestFailureKind =
  | 'timeout'
  | 'aborted'
  | 'provider'
  | 'invalid-response'
  | 'invalid-output'
  | 'stale';

export type ExtractionFailureKind = RequestFailureKind;
export type DiscoveryFailureKind = RequestFailureKind;

export interface PersistedStateV1 {
  readonly schemaVersion: 1;
  readonly recovery: RecoveryMode;
  readonly items: readonly ContextItem[];
}

export interface PersistedStateV2 {
  readonly schemaVersion: 2;
  readonly recovery: RecoveryMode;
  readonly extraction: ExtractionMode;
  readonly items: readonly ContextItem[];
  readonly autoItemIds: readonly string[];
}

/**
 * Half-open [startOffset, endOffset) in UTF-16 code units over the joined text
 * blocks of one tool result: `event.content.filter(isTextBlock).map((block) =>
 * block.text).join('')`. Changing the unit or normalizing the text would make
 * persisted spans unresolvable.
 */
export interface DiscoveryEvidenceSpan {
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface DiscoveryProvenance {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly quoteHash: string;
  /** Absent for provenance persisted before schema v4. */
  readonly span?: DiscoveryEvidenceSpan;
}

export interface PersistedStateV3 {
  readonly schemaVersion: 3;
  readonly recovery: RecoveryMode;
  readonly extraction: ExtractionMode;
  readonly discovery: DiscoveryMode;
  readonly items: readonly ContextItem[];
  readonly autoItemIds: readonly string[];
  readonly discoveryItemIds: readonly string[];
  readonly discoveryProvenance: Readonly<Record<string, readonly DiscoveryProvenance[]>>;
}

/**
 * Whether a captured discovery still carries authority. Evidence-backed and
 * currently authoritative are different properties: a fact can stay perfectly
 * supported by its evidence long after a newer observation replaced it.
 */
export type DiscoveryLifecycleStatus = 'active' | 'superseded' | 'retired';

export interface DiscoveryLifecycle {
  readonly status: DiscoveryLifecycleStatus;
  /**
   * Timestamp when this lifecycle record was first created or materialised.
   * This is not evidence observation time, fact capture time for migrated rows,
   * truth start time, or a freshness signal.
   */
  readonly createdAt: string;
  /** Timestamp when the lifecycle status last changed. */
  readonly updatedAt: string;
  /** Set only when status is 'superseded': the discovery id that replaced it. */
  readonly supersededBy?: string;
}

export interface PersistedStateV4 {
  readonly schemaVersion: 4;
  readonly recovery: RecoveryMode;
  readonly extraction: ExtractionMode;
  readonly discovery: DiscoveryMode;
  readonly items: readonly ContextItem[];
  readonly autoItemIds: readonly string[];
  readonly discoveryItemIds: readonly string[];
  readonly discoveryProvenance: Readonly<Record<string, readonly DiscoveryProvenance[]>>;
}

export interface PersistedStateV5 {
  readonly schemaVersion: 5;
  readonly recovery: RecoveryMode;
  readonly extraction: ExtractionMode;
  readonly discovery: DiscoveryMode;
  readonly items: readonly ContextItem[];
  readonly autoItemIds: readonly string[];
  readonly discoveryItemIds: readonly string[];
  readonly discoveryProvenance: Readonly<Record<string, readonly DiscoveryProvenance[]>>;
  readonly discoveryLifecycle: Readonly<Record<string, DiscoveryLifecycle>>;
}

/**
 * New persisted state. The loader also accepts PersistedStateV1 through V4;
 * discoveries restored from those load as 'active'.
 */
export type PersistedState = PersistedStateV5;

export type LastExtraction =
  | {
      readonly status: 'success';
      readonly added: number;
      readonly retired: number;
    }
  | {
      readonly status: 'failed';
      readonly added: 0;
      readonly retired: 0;
      readonly failureKind: ExtractionFailureKind;
    };

export type LastDiscovery =
  | {
      readonly status: 'success';
      readonly added: number;
    }
  | {
      readonly status: 'failed';
      readonly added: 0;
      readonly failureKind: DiscoveryFailureKind;
    };

export interface RuntimeState {
  guard: ContextGuard;
  recovery: RecoveryMode;
  extraction: ExtractionMode;
  discovery: DiscoveryMode;
  autoItemIds: Set<string>;
  discoveryItemIds: Set<string>;
  discoveryProvenance: Map<string, readonly DiscoveryProvenance[]>;
  discoveryLifecycle: Map<string, DiscoveryLifecycle>;
  degraded: boolean;
  lastExtraction: LastExtraction | undefined;
  lastDiscovery: LastDiscovery | undefined;
}

export interface LastVerification {
  readonly compactionId: string;
  readonly report: VerificationReport;
}
