import { judgeToolPolicy } from '@j1nn0/agent-tool-policy';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import { registerAgentToolPolicyCommand } from './command.js';
import {
  APPROVAL_DENIED_REASON,
  CORRUPT_BLOCK_REASON,
  CORRUPT_WARNING,
  DENIED_REASON,
  JUDGMENT_FAILED_REASON,
  NO_UI_APPROVAL_REASON,
  UNCONFIGURED_BLOCK_REASON,
  UNCONFIGURED_WARNING,
  approvalMessage,
  approvalTitle,
} from './messages.js';
import {
  createUnconfiguredState,
  loadState,
  saveState,
  type PolicyMode,
  type StateController,
} from './state.js';

export async function enforceToolCall(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  state: PolicyMode,
): Promise<ToolCallEventResult | undefined> {
  switch (state.kind) {
    case 'unconfigured':
      return { block: true, reason: UNCONFIGURED_BLOCK_REASON };
    case 'corrupt':
      return { block: true, reason: CORRUPT_BLOCK_REASON };
    case 'disabled':
      return undefined;
    case 'enforcing': {
      try {
        const verdict = judgeToolPolicy({ tool: event.toolName, policy: state.policy });

        switch (verdict.outcome) {
          case 'allowed':
            return undefined;
          case 'denied':
            return { block: true, reason: DENIED_REASON };
          case 'requires_approval':
            if (!ctx.hasUI) {
              return { block: true, reason: NO_UI_APPROVAL_REASON };
            }

            try {
              const options = ctx.signal === undefined ? {} : { signal: ctx.signal };
              const approved = await ctx.ui.confirm(
                approvalTitle(event.toolName),
                approvalMessage(event.toolName),
                options,
              );
              if (approved === true) {
                return undefined;
              }
            } catch {
              return { block: true, reason: APPROVAL_DENIED_REASON };
            }

            return { block: true, reason: APPROVAL_DENIED_REASON };
          default:
            return { block: true, reason: JUDGMENT_FAILED_REASON };
        }
      } catch {
        return { block: true, reason: JUDGMENT_FAILED_REASON };
      }
    }
    default:
      return { block: true, reason: JUDGMENT_FAILED_REASON };
  }
}

export default function registerAgentToolPolicyExtension(pi: ExtensionAPI): void {
  let state: PolicyMode = createUnconfiguredState();

  const controller: StateController = {
    getState: (): PolicyMode => state,
    replaceState: (next: PolicyMode): void => {
      state = next;
    },
    persist: (): void => {
      saveState(pi, state);
    },
  };

  registerAgentToolPolicyCommand(pi, controller);

  pi.on('session_start', (_event, ctx): void => {
    state = loadState(ctx);
    if (state.kind === 'unconfigured') {
      ctx.ui.notify(UNCONFIGURED_WARNING, 'warning');
    } else if (state.kind === 'corrupt') {
      ctx.ui.notify(CORRUPT_WARNING, 'warning');
    }
  });

  pi.on('tool_call', async (event, ctx): Promise<ToolCallEventResult | undefined> => {
    return await enforceToolCall(event, ctx, state);
  });
}
