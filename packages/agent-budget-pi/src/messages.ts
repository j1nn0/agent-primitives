import { BudgetError } from '@j1nn0/agent-budget';

export const NOTIFICATION_PREFIX = 'Agent Budget: ';

export const INVALID_STATE_WARNING =
  `${NOTIFICATION_PREFIX}persisted state was invalid; starting with fresh state.`;

export const USAGE =
  `${NOTIFICATION_PREFIX}Usage: /agent-budget status | set <id> --consumed <number> --limit <number> | remove <id> | judge | clear [--yes]`;

export function createdBudgetMessage(id: string): string {
  return `${NOTIFICATION_PREFIX}created budget "${id}".`;
}

export function replacedBudgetMessage(id: string): string {
  return `${NOTIFICATION_PREFIX}replaced budget "${id}" in place.`;
}

export function unchangedBudgetMessage(id: string): string {
  return `${NOTIFICATION_PREFIX}budget "${id}" unchanged; nothing was written.`;
}

export function removedBudgetMessage(id: string): string {
  return `${NOTIFICATION_PREFIX}removed budget "${id}".`;
}

export function unknownBudgetMessage(id: string): string {
  return `${NOTIFICATION_PREFIX}unknown budget "${id}"; state was unchanged.`;
}

export function invalidBudgetInputMessage(): string {
  return `${NOTIFICATION_PREFIX}invalid budget input.`;
}

export function clearConfirmationMessage(count: number): string {
  const noun = count === 1 ? 'budget' : 'budgets';
  return `${NOTIFICATION_PREFIX}clear would remove ${count} ${noun}. Run /agent-budget clear --yes to confirm.`;
}

export function clearedBudgetsMessage(count: number): string {
  const noun = count === 1 ? 'budget' : 'budgets';
  return `${NOTIFICATION_PREFIX}cleared ${count} ${noun}.`;
}

export function nothingToClearMessage(): string {
  return `${NOTIFICATION_PREFIX}nothing to clear.`;
}

export function formatBudgetError(error: unknown): string {
  if (error instanceof BudgetError && error.code === 'invalid_input') {
    return invalidBudgetInputMessage();
  }
  return invalidBudgetInputMessage();
}
