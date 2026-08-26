export type EvidenceOutcome = 'confirmed' | 'refuted' | 'unknown';

export type UnsupportedReason =
  | 'missing_evidence'
  | 'unconfirmed_evidence'
  | 'subject_mismatch';

export type ClaimOutcome = 'supported' | 'contradicted' | 'unsupported';

export type EvidenceErrorCode = 'invalid_input';

export interface EvidenceRecord {
  readonly id: string;
  readonly outcome: EvidenceOutcome;
  readonly subject?: string;
}

export interface ClaimRequirement {
  readonly evidenceId: string;
  readonly subject?: string;
}

export interface EvidenceClaim {
  readonly id: string;
  readonly requires: readonly ClaimRequirement[];
}

export type ClaimResult =
  | {
      readonly claimId: string;
      readonly outcome: 'supported';
    }
  | {
      readonly claimId: string;
      readonly outcome: 'contradicted';
      readonly evidenceId: string;
    }
  | {
      readonly claimId: string;
      readonly outcome: 'unsupported';
      readonly reason: UnsupportedReason;
      readonly evidenceId: string;
    };

export interface EvidenceVerdict {
  readonly claims: readonly ClaimResult[];
}
