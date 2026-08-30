import type {
  ExtensionAPI,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { registerAgentRetryCommand } from './command.js';
import { registerAgentRetryTools } from './tools.js';
import {
  addAttempt,
  createEmptyState,
  loadAutoRecordEnabled,
  loadState,
  persistAutoRecordEnabled,
  saveState,
  type RetryState,
} from './state.js';

export function shouldAutoRecord(autoRecordEnabled: boolean, event: unknown): boolean {
  if (!autoRecordEnabled || typeof event !== 'object' || event === null) {
    return false;
  }

  const candidate = event as {
    readonly type?: unknown;
    readonly toolName?: unknown;
    readonly isError?: unknown;
  };
  return (
    candidate.type === 'tool_result' &&
    typeof candidate.toolName === 'string' &&
    !candidate.toolName.startsWith('agent_retry_') &&
    candidate.isError === true
  );
}

export default function registerAgentRetryExtension(pi: ExtensionAPI): void {
  let state: RetryState = createEmptyState();
  let autoRecordEnabled = false;

  const controller = {
    getState: (): RetryState => state,
    replaceState: (next: RetryState): void => {
      state = next;
    },
    persist: (): void => {
      saveState(pi, state);
    },
  };

  const autoRecordController = {
    replaceEnabled: (enabled: boolean): void => {
      autoRecordEnabled = enabled;
    },
    persist: (enabled: boolean): void => {
      persistAutoRecordEnabled(pi, enabled);
    },
  };

  registerAgentRetryCommand(pi, controller, autoRecordController);
  registerAgentRetryTools(pi, controller);

  pi.on('session_start', (_event, ctx): void => {
    state = loadState(ctx);
    autoRecordEnabled = loadAutoRecordEnabled(ctx);
  });

  pi.on('tool_result', (event: ToolResultEvent): undefined => {
    const previousState = state;
    try {
      if (!shouldAutoRecord(autoRecordEnabled, event)) {
        return undefined;
      }

      const result = addAttempt(state, 'failure');
      if (result.changed) {
        state = result.state;
        controller.replaceState(state);
        controller.persist();
      }
    } catch {
      state = previousState;
      try {
        controller.replaceState(previousState);
      } catch {
        // Keep recorder failures isolated from the tool result.
      }
    }
    return undefined;
  });
}
