import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerAgentProgressCommand } from './command.js';
import { registerAgentProgressTools } from './tools.js';
import {
  createEmptyState,
  loadState,
  saveState,
  type ProgressState,
} from './state.js';

export default function registerAgentProgressExtension(
  pi: ExtensionAPI,
): void {
  let state: ProgressState = createEmptyState();

  const controller = {
    getState: (): ProgressState => state,
    replaceState: (next: ProgressState): void => {
      state = next;
    },
    persist: (): void => {
      saveState(pi, state);
    },
  };

  registerAgentProgressCommand(pi, controller);
  registerAgentProgressTools(pi, controller);

  pi.on('session_start', (_event, ctx): void => {
    state = loadState(ctx);
  });
}
