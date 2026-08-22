export type ContextItemKind = 'goal' | 'constraint' | 'requirement' | 'decision' | 'fact';

export type VerificationStatus = 'preserved' | 'changed' | 'lost' | 'unknown';

export type ContextGuardErrorCode = 'duplicate_item_id' | 'invalid_input';

export interface ContextItemInput {
  id: string;
  kind: ContextItemKind;
  content: string;
  critical?: boolean;
}

export interface ContextItem {
  readonly id: string;
  readonly kind: ContextItemKind;
  readonly content: string;
  readonly critical: boolean;
}

export interface ContextSnapshot {
  readonly schemaVersion: 1;
  readonly items: readonly ContextItem[];
}

export interface ContextVerifier {
  verify(
    input: ContextVerifierInput,
  ):
    | VerificationFinding[]
    | readonly VerificationFinding[]
    | Promise<readonly VerificationFinding[]>;
}

export interface ContextVerifierInput {
  readonly items: readonly ContextItem[];
  readonly context: string;
}

export interface VerificationFinding {
  readonly itemId: string;
  readonly status: VerificationStatus;
  readonly reason?: string;
}

export interface VerificationReport {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly findings: readonly VerificationFinding[];
  readonly preserved: readonly string[];
  readonly changed: readonly string[];
  readonly lost: readonly string[];
  readonly unknown: readonly string[];
  readonly criticalFailures: readonly string[];
  readonly issues: readonly string[];
}

export interface VerifyContextInput {
  readonly snapshot: ContextSnapshot;
  readonly context: string;
  readonly verifier: ContextVerifier;
}

export interface VerifyOptions {
  readonly verifier: ContextVerifier;
}

export interface LiteralVerifierOptions {
  readonly caseSensitive?: boolean;
  readonly normalizeWhitespace?: boolean;
}

export interface ContextGuard {
  add(item: ContextItemInput): ContextItem;
  addAll(items: readonly ContextItemInput[]): readonly ContextItem[];
  get(id: string): ContextItem | undefined;
  list(): readonly ContextItem[];
  has(id: string): boolean;
  remove(id: string): boolean;
  clear(): void;
  size(): number;
  snapshot(): ContextSnapshot;
  verify(context: string, options: VerifyOptions): Promise<VerificationReport>;
}
