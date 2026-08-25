import { judgeProgress } from '@j1nn0/agent-progress';
import type { ProgressObservation } from '@j1nn0/agent-progress';

const observedRounds: readonly ProgressObservation[] = [
  { milestones: ['planned'] },
  { milestones: ['planned', 'implemented'] },
  { milestones: ['implemented', 'planned'] },
  { milestones: ['implemented'] },
];

let recorded: ProgressObservation | undefined;
for (const [round, current] of observedRounds.entries()) {
  const verdict = judgeProgress({
    ...(recorded === undefined ? {} : { previous: recorded }),
    current,
  });
  console.log(`round ${round + 1}:`, verdict);

  recorded = { milestones: verdict.recordedMilestones };
}
