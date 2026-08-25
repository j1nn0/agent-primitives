export type ProgressOutcome = 'progress' | 'no_progress' | 'unknown';
export type ProgressUnknownReason = 'missing_baseline';
export type ProgressErrorCode = 'invalid_input' | 'duplicate_milestone';

export interface ProgressObservation {
  readonly milestones: readonly string[];
}

export interface ProgressJudgeInput {
  readonly previous?: ProgressObservation;
  readonly current: ProgressObservation;
}

export type ProgressVerdict =
  | {
      readonly outcome: 'progress';
      readonly newMilestones: readonly string[];
      readonly withdrawnMilestones?: readonly string[];
      readonly recordedMilestones: readonly string[];
    }
  | {
      readonly outcome: 'no_progress';
      readonly newMilestones: readonly [];
      readonly withdrawnMilestones?: readonly string[];
      readonly recordedMilestones: readonly string[];
    }
  | {
      readonly outcome: 'unknown';
      readonly reason: ProgressUnknownReason;
      readonly recordedMilestones: readonly string[];
    };
