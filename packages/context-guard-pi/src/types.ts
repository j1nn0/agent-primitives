import type {
  ContextGuard,
  ContextItem,
  VerificationReport,
} from '@j1nn0/agent-context-guard';

/** Controls whether lost critical items are injected after verification. */
export type RecoveryMode = 'off' | 'critical';

export interface PersistedState {
  readonly schemaVersion: 1;
  readonly recovery: RecoveryMode;
  readonly items: readonly ContextItem[];
}

export interface RuntimeState {
  guard: ContextGuard;
  recovery: RecoveryMode;
  degraded: boolean;
}

export interface LastVerification {
  readonly compactionId: string;
  readonly report: VerificationReport;
}
