import {
  summarizeAgentState,
  type AgentState,
} from '@j1nn0/agent-state';

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export function formatAgentState(state: AgentState): string {
  const snapshot = state.snapshot();
  const summary = summarizeAgentState(snapshot);
  const objective =
    snapshot.objective === undefined
      ? 'no objective'
      : `objective: ${snapshot.objective}`;
  const workItemLabel = pluralize(summary.total, 'work item');
  const decisionCount = snapshot.decisions.length;
  const decisionLabel = pluralize(decisionCount, 'decision');
  const statusCounts =
    summary.total === 0
      ? ''
      : ` (${summary.open} open, ${summary.in_progress} in_progress, ${summary.blocked} blocked, ${summary.done} done)`;

  const lines = [
    `Agent State: ${objective}, ${summary.total} ${workItemLabel}${statusCounts}, ${decisionCount} ${decisionLabel}.`,
  ];

  if (snapshot.workItems.length > 0) {
    lines.push('Work items:');
    for (const item of snapshot.workItems) {
      lines.push(`- ${item.id} [${item.status}]: ${item.content}`);
    }
  }

  if (snapshot.decisions.length > 0) {
    lines.push('Decisions:');
    for (const decision of snapshot.decisions) {
      lines.push(`- ${decision.id}: ${decision.content}`);
    }
  }

  return lines.join('\n');
}
