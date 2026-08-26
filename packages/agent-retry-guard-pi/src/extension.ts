import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerAgentRetryCommand } from './command.js';
import { registerAgentRetryTools } from './tools.js';
import {
  createEmptyState,
  loadState,
  saveState,
  type RetryState,
} from './state.js';

export default function registerAgentRetryExtension(pi: ExtensionAPI): void {
  let state: RetryState = createEmptyState();

  const controller = {
    getState: (): RetryState => state,
    replaceState: (next: RetryState): void => {
      state = next;
    },
    persist: (): void => {
      saveState(pi, state);
    },
  };

  registerAgentRetryCommand(pi, controller);
  registerAgentRetryTools(pi, controller);

  pi.on('session_start', (_event, ctx): void => {
    state = loadState(ctx);
  });
}
