import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerAgentBudgetCommand } from './command.js';
import { registerAgentBudgetTools } from './tools.js';
import { createEmptyState, loadState, saveState, type BudgetState } from './state.js';

export default function registerAgentBudgetExtension(pi: ExtensionAPI): void {
  let state: BudgetState = createEmptyState();

  const controller = {
    getState: (): BudgetState => state,
    replaceState: (next: BudgetState): void => {
      state = next;
    },
    persist: (): void => {
      saveState(pi, state);
    },
  };

  registerAgentBudgetCommand(pi, controller);
  registerAgentBudgetTools(pi, controller);

  pi.on('session_start', (_event, ctx): void => {
    state = loadState(ctx);
  });
}
