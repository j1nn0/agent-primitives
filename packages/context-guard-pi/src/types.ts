import type {
  ContextGuard,
  ContextItem,
  VerificationReport,
} from '@j1nn0/agent-context-guard';

/** Controls whether lost critical items are injected after verification. */
export type RecoveryMode = 'off' | 'critical';

/** Controls whether protected items are extracted from user messages. */
export type ExtractionMode = 'off' | 'automatic';

export type ExtractionFailureKind =
  | 'timeout'
  | 'aborted'
  | 'provider'
  | 'invalid-response'
  | 'invalid-output'
  | 'stale';

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

/** New persisted state. The loader also accepts PersistedStateV1. */
export type PersistedState = PersistedStateV2;

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

export interface RuntimeState {
  guard: ContextGuard;
  recovery: RecoveryMode;
  extraction: ExtractionMode;
  autoItemIds: Set<string>;
  degraded: boolean;
  lastExtraction: LastExtraction | undefined;
}

export interface LastVerification {
  readonly compactionId: string;
  readonly report: VerificationReport;
}
