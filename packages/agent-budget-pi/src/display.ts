import { judgeBudget } from '@j1nn0/agent-budget';
import type { BudgetState } from './state.js';

export function formatStateSummary(state: BudgetState): string {
  const count = state.budgets.length;
  const lines: string[] = [
    `Agent Budget: ${count} budget${count === 1 ? '' : 's'} in the current session.`,
  ];

  for (const budget of state.budgets) {
    lines.push(`- ${budget.id}: consumed=${budget.consumed} limit=${budget.limit}`);
  }

  return lines.join('\n');
}

export function judgeBudgetText(state: BudgetState): string {
  const count = state.budgets.length;
  if (count === 0) {
    return 'Agent Budget: no budgets to judge.';
  }

  const lines: string[] = [`Agent Budget judged ${count} budget(s):`];
  for (const budget of state.budgets) {
    const verdict = judgeBudget({ consumed: budget.consumed, limit: budget.limit });
    lines.push(
      `- ${budget.id}: ${verdict.outcome} (remaining ${String(verdict.remaining)})`,
    );
  }

  return lines.join('\n');
}
