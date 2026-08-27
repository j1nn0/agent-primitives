import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerAgentHandoffCommand } from './command.js';
import { registerAgentHandoffTools } from './tools.js';
import { createEmptyState, loadState, saveState, type HandoffState } from './state.js';

export default function registerAgentHandoffExtension(pi: ExtensionAPI): void {
  let state: HandoffState = createEmptyState();

  const controller = {
    getState: (): HandoffState => state,
    replaceState: (next: HandoffState): void => {
      state = next;
    },
    persist: (): void => {
      saveState(pi, state);
    },
  };

  registerAgentHandoffCommand(pi, controller);
  registerAgentHandoffTools(pi, controller);

  pi.on('session_start', (_event, ctx): void => {
    state = loadState(ctx);
  });
}
