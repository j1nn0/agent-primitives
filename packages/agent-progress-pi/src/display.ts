import type { ProgressVerdict } from '@j1nn0/agent-progress';
import type { ProgressState } from './state.js';

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function milestoneLines(
  label: string,
  milestones: readonly string[],
): string[] {
  if (milestones.length === 0) {
    return [`${label}: none.`];
  }
  return [`${label}:`, ...milestones.map((milestone) => `- ${milestone}`)];
}

export function formatProgressState(state: ProgressState): string {
  const currentLabel = pluralize(state.currentMilestones.length, 'milestone');
  const recordedLabel = pluralize(
    state.recordedMilestones.length,
    'milestone',
  );
  const baseline = state.hasBaseline ? 'established' : 'not established';
  const lines = [
    `Agent Progress: ${state.currentMilestones.length} declared ${currentLabel}; baseline ${baseline} (${state.recordedMilestones.length} recorded ${recordedLabel}).`,
    ...milestoneLines('Declared milestones', state.currentMilestones),
  ];
  return lines.join('\n');
}

export function formatProgressVerdict(verdict: ProgressVerdict): string {
  const lines: string[] = [];
  if (verdict.outcome === 'unknown') {
    lines.push(`Agent Progress: unknown (${verdict.reason}).`);
    lines.push(
      ...milestoneLines('Recorded milestones', verdict.recordedMilestones),
    );
    return lines.join('\n');
  }

  lines.push(`Agent Progress: ${verdict.outcome}.`);
  lines.push(...milestoneLines('New milestones', verdict.newMilestones));
  if (verdict.withdrawnMilestones !== undefined) {
    lines.push(
      ...milestoneLines(
        'Withdrawn milestones',
        verdict.withdrawnMilestones,
      ),
    );
  }
  lines.push(
    ...milestoneLines('Recorded milestones', verdict.recordedMilestones),
  );
  return lines.join('\n');
}
