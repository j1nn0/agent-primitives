import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerAgentEvidenceCommand } from './command.js';
import { registerAgentEvidenceTools } from './tools.js';
import {
  createEmptyState,
  loadState,
  saveState,
  type EvidenceState,
} from './state.js';

export default function registerAgentEvidenceExtension(pi: ExtensionAPI): void {
  let state: EvidenceState = createEmptyState();

  const controller = {
    getState: (): EvidenceState => state,
    replaceState: (next: EvidenceState): void => {
      state = next;
    },
    persist: (): void => {
      saveState(pi, state);
    },
  };

  registerAgentEvidenceCommand(pi, controller);
  registerAgentEvidenceTools(pi, controller);

  pi.on('session_start', (_event, ctx): void => {
    state = loadState(ctx);
  });
}
