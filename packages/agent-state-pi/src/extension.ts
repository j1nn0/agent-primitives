import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AgentState } from '@j1nn0/agent-state';
import { registerAgentStateCommand } from './command.js';
import { registerAgentStateTools } from './tools.js';
import {
  createEmptyState,
  loadState,
  saveState,
} from './state.js';

export default function registerAgentStateExtension(pi: ExtensionAPI): void {
  let state: AgentState = createEmptyState();

  const controller = {
    getState: (): AgentState => state,
    replaceState: (next: AgentState): void => {
      state = next;
    },
    persist: (): void => {
      saveState(pi, state);
    },
  };

  registerAgentStateCommand(pi, controller);
  registerAgentStateTools(pi, controller);

  pi.on('session_start', (_event, ctx): void => {
    state = loadState(ctx);
  });
}
