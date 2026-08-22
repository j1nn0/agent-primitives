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

export interface DiscoveryProvenance {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly quoteHash: string;
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

/** New persisted state. The loader also accepts PersistedStateV1 and V2. */
export type PersistedState = PersistedStateV3;

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
  degraded: boolean;
  lastExtraction: LastExtraction | undefined;
  lastDiscovery: LastDiscovery | undefined;
}

export interface LastVerification {
  readonly compactionId: string;
  readonly report: VerificationReport;
}
