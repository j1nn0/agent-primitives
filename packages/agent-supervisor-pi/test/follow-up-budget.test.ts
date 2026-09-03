import { describe, expect, it } from 'vitest';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  SessionEntry,
  ToolResultEvent,
  TurnEndEvent,
} from '@earendil-works/pi-coding-agent';
import { SUPERVISOR_CONFIG_CUSTOM_TYPE } from '../src/config.js';
import { validateSupervisorFeatureDescriptor } from '../src/feature.js';
import { validateSupervisorInterventionProposal } from '../src/intervention.js';
import type {
  SupervisorInterventionIntent,
  SupervisorInterventionProposal,
} from '../src/intervention.js';
import { SupervisorKernel } from '../src/kernel/kernel.js';
import type { SupervisorObservation, SupervisorObservationKind } from '../src/observation.js';
import type { SupervisorFeatureModule } from '../src/module.js';

const ROOT_ID = 'root-1';

type EventHandler = (event: unknown, context: ExtensionContext) => Promise<unknown> | unknown;
type CommandHandler = (args: string, context: ExtensionCommandContext) => Promise<void>;
type ProposalScript = (
  observation: SupervisorObservation,
  invocation: number,
) => SupervisorInterventionProposal | undefined;

interface SentMessage {
  readonly content: unknown;
  readonly options: unknown;
}

function customEntry(customType: string, data: unknown): SessionEntry {
  return {
    type: 'custom',
    id: `seed-${customType}`,
    parentId: null,
    timestamp: '1970-01-01T00:00:00.000Z',
    customType,
    data,
  } as SessionEntry;
}

class RecordingPi {
  public readonly handlers = new Map<string, EventHandler>();

  public readonly commands = new Map<string, CommandHandler>();

  public readonly sentMessages: SentMessage[] = [];

  public readonly notifications: string[] = [];

  public readonly branch: SessionEntry[];

  public readonly pi: ExtensionAPI;

  public constructor(initialBranch: readonly SessionEntry[] = []) {
    this.branch = [...initialBranch];
    this.pi = {
      on: (type: string, handler: unknown): void => {
        this.handlers.set(type, handler as EventHandler);
      },
      registerCommand: (name: string, options: { handler: CommandHandler }): void => {
        this.commands.set(name, options.handler);
      },
      appendEntry: (customType: string, data?: unknown): void => {
        this.branch.push(customEntry(customType, data));
      },
      sendUserMessage: (content: unknown, options?: unknown): void => {
        this.sentMessages.push({ content, options });
      },
      getAllTools: (): readonly unknown[] => [],
    } as unknown as ExtensionAPI;
  }

  public context(): ExtensionContext {
    return {
      sessionManager: {
        getBranch: (): SessionEntry[] => this.branch,
        getSessionId: (): string => 'session-1',
      },
      ui: {
        notify: (message: string): void => {
          this.notifications.push(message);
        },
      },
    } as unknown as ExtensionContext;
  }

  public async emit(type: string, event: unknown): Promise<unknown> {
    const handler = this.handlers.get(type);
    if (handler === undefined) {
      throw new Error(`No handler for ${type}`);
    }
    return handler(event, this.context());
  }
}

function inputEvent(source: 'interactive' | 'rpc' | 'extension' = 'interactive'): InputEvent {
  return { type: 'input', source, text: 'private prompt' } as InputEvent;
}

function toolResultEvent(toolCallId = 'call-1'): ToolResultEvent {
  return {
    type: 'tool_result',
    toolCallId,
    toolName: 'test-tool',
    input: { private: 'input' },
    content: [{ type: 'text', text: 'private result' }],
    isError: false,
    details: { private: 'details' },
  } as ToolResultEvent;
}

function turnEndEvent(): TurnEndEvent {
  return {
    type: 'turn_end',
    turnIndex: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: 'private response' }] },
    toolResults: [],
  } as unknown as TurnEndEvent;
}

function proposal(
  sourceFeatureId: string,
  delivery: 'block' | 'steer' | 'follow-up' | 'none',
  overrides: Record<string, unknown> = {},
): SupervisorInterventionProposal {
  const base: Record<string, unknown> = {
    sourceFeatureId,
    boundary: delivery === 'block' ? 'tool-call' : 'stream',
    intent:
      delivery === 'block' ? 'stop' : delivery === 'steer' ? 'change-strategy' : 'continue',
    delivery,
    priority: delivery === 'none' ? 100 : 1,
    reasonCode: `${sourceFeatureId}:${delivery}`,
  };
  if (delivery !== 'none') {
    base.message = `${sourceFeatureId} ${delivery}`;
  }
  if (delivery === 'block') {
    base.targetToolCallId = 'call-1';
  }
  return validateSupervisorInterventionProposal({ ...base, ...overrides });
}

function scriptedFeature(
  id: string,
  observes: readonly SupervisorObservationKind[],
  interventionIntents: readonly SupervisorInterventionIntent[],
  script: ProposalScript,
): SupervisorFeatureModule {
  return {
    descriptor: validateSupervisorFeatureDescriptor({
      id,
      schemaVersion: 1,
      maturity: 'validated',
      defaultMode: 'autonomous',
      observes: [...observes],
      provides: [],
      requires: [],
      conflictsWith: [],
      usesAuxiliaryModel: false,
      interventionIntents: [...interventionIntents],
    }),
    create: () => {
      let invocations = 0;
      return {
        onObservation: (observation) => {
          invocations += 1;
          const intervention = script(observation, invocations);
          return intervention === undefined ? undefined : { interventions: [intervention] };
        },
      };
    },
  };
}

function createKernel(
  recording: RecordingPi,
  features: readonly SupervisorFeatureModule[],
): SupervisorKernel {
  const kernel = new SupervisorKernel(recording.pi, features);
  kernel.register();
  return kernel;
}

function staleObservation(rootRequestId: string): SupervisorObservation {
  return {
    schemaVersion: 1,
    id: 'stale-observation',
    sequence: 1,
    rootRequestId,
    kind: 'tool-result',
    payload: {
      toolCallId: 'stale-call',
      toolName: 'test-tool',
      inputDigest: null,
      isError: false,
      resultDigest: null,
    },
  };
}

async function dispatchDirectly(
  kernel: SupervisorKernel,
  observation: SupervisorObservation,
): Promise<void> {
  const dispatchAndIntervene = (
    kernel as unknown as {
      dispatchAndIntervene: (
        observation: SupervisorObservation,
        targetToolCallId: string | undefined,
      ) => Promise<unknown>;
    }
  ).dispatchAndIntervene;
  await dispatchAndIntervene.call(kernel, observation, undefined);
}

function followUpFeature(id = 'follow-up-feature'): SupervisorFeatureModule {
  return scriptedFeature(id, ['tool-result'], ['continue'], () => proposal(id, 'follow-up'));
}

describe('Kernel automatic follow-up budget', () => {
  it('transports the first autonomous follow-up winner and consumes the budget', async () => {
    const recording = new RecordingPi();
    createKernel(recording, [followUpFeature()]);

    await recording.emit('input', inputEvent());
    await recording.emit('tool_result', toolResultEvent());

    expect(recording.sentMessages).toEqual([
      { content: 'follow-up-feature follow-up', options: { deliverAs: 'followUp' } },
    ]);
  });

  it('does not transport a second follow-up winner in the same Root Request', async () => {
    const recording = new RecordingPi();
    createKernel(recording, [followUpFeature()]);

    await recording.emit('input', inputEvent());
    await recording.emit('tool_result', toolResultEvent('call-1'));
    await recording.emit('tool_result', toolResultEvent('call-2'));

    expect(recording.sentMessages).toHaveLength(1);
  });

  it('resets the budget for a new interactive Root Request', async () => {
    const recording = new RecordingPi();
    createKernel(recording, [followUpFeature()]);

    await recording.emit('input', inputEvent());
    await recording.emit('tool_result', toolResultEvent('call-1'));
    await recording.emit('input', inputEvent());
    await recording.emit('tool_result', toolResultEvent('call-2'));

    expect(recording.sentMessages).toHaveLength(2);
  });

  it('preserves the exhausted budget across an extension-sourced input', async () => {
    const recording = new RecordingPi();
    createKernel(recording, [followUpFeature()]);

    await recording.emit('input', inputEvent());
    await recording.emit('tool_result', toolResultEvent('call-1'));
    await recording.emit('input', inputEvent('extension'));
    await recording.emit('tool_result', toolResultEvent('call-2'));

    expect(recording.sentMessages).toHaveLength(1);
  });

  it('does not consume the budget for an observe-mode proposal', async () => {
    const observeId = 'observe-proposer';
    const autonomousId = 'autonomous-proposer';
    const recording = new RecordingPi([
      customEntry(SUPERVISOR_CONFIG_CUSTOM_TYPE, {
        schemaVersion: 1,
        mode: 'autonomous',
        features: {
          [observeId]: { mode: 'observe' },
          [autonomousId]: { mode: 'autonomous' },
        },
      }),
    ]);
    createKernel(recording, [
      scriptedFeature(observeId, ['tool-result'], ['continue'], () => proposal(observeId, 'follow-up')),
      scriptedFeature(autonomousId, ['turn-ended'], ['continue'], () =>
        proposal(autonomousId, 'follow-up'),
      ),
    ]);

    await recording.emit('input', inputEvent());
    await recording.emit('tool_result', toolResultEvent());
    expect(recording.sentMessages).toHaveLength(0);
    await recording.emit('turn_end', turnEndEvent());

    expect(recording.sentMessages).toEqual([
      { content: 'autonomous-proposer follow-up', options: { deliverAs: 'followUp' } },
    ]);
  });

  it('does not consume the budget for an arbitration loser', async () => {
    const loserId = 'follow-up-loser';
    const noneId = 'none-winner';
    const recording = new RecordingPi();
    createKernel(recording, [
      scriptedFeature(loserId, ['tool-result'], ['continue'], (_observation, invocation) =>
        invocation <= 2 ? proposal(loserId, 'follow-up') : undefined,
      ),
      scriptedFeature(noneId, ['tool-result'], ['continue'], (_observation, invocation) =>
        invocation === 1 ? proposal(noneId, 'none') : undefined,
      ),
    ]);

    await recording.emit('input', inputEvent());
    await recording.emit('tool_result', toolResultEvent('call-1'));
    await recording.emit('tool_result', toolResultEvent('call-2'));

    expect(recording.sentMessages).toEqual([
      { content: 'follow-up-loser follow-up', options: { deliverAs: 'followUp' } },
    ]);
  });

  it('does not consume the budget for a delivery-none winner', async () => {
    const id = 'none-then-follow-up';
    const recording = new RecordingPi();
    createKernel(recording, [
      scriptedFeature(id, ['tool-result'], ['continue'], (_observation, invocation) =>
        invocation === 1 ? proposal(id, 'none') : proposal(id, 'follow-up'),
      ),
    ]);

    await recording.emit('input', inputEvent());
    await recording.emit('tool_result', toolResultEvent('call-1'));
    await recording.emit('tool_result', toolResultEvent('call-2'));

    expect(recording.sentMessages).toEqual([
      { content: 'none-then-follow-up follow-up', options: { deliverAs: 'followUp' } },
    ]);
  });

  it('does not transport or consume a follow-up from a superseded Root Request', async () => {
    const id = 'stale-proposer';
    const recording = new RecordingPi();
    const kernel = createKernel(recording, [followUpFeature(id)]);

    await recording.emit('input', inputEvent());
    await recording.emit('input', inputEvent());
    await dispatchDirectly(kernel, staleObservation(ROOT_ID));
    expect(recording.sentMessages).toHaveLength(0);

    await recording.emit('tool_result', toolResultEvent());

    expect(recording.sentMessages).toEqual([
      { content: 'stale-proposer follow-up', options: { deliverAs: 'followUp' } },
    ]);
  });

  it('leaves block and steer transports unaffected by the follow-up budget', async () => {
    const id = 'mixed-transports';
    const recording = new RecordingPi();
    createKernel(recording, [
      scriptedFeature(id, ['before-tool-call', 'tool-result'], ['stop', 'change-strategy', 'continue'],
        (observation, invocation) => {
          if (observation.kind === 'tool-result') {
            return invocation === 1 ? proposal(id, 'follow-up') : proposal(id, 'steer');
          }
          return proposal(id, 'block');
        },
      ),
    ]);

    await recording.emit('input', inputEvent());
    await recording.emit('tool_result', toolResultEvent('call-1'));
    await recording.emit('tool_result', toolResultEvent('call-2'));
    const blocked = await recording.emit('tool_call', {
      type: 'tool_call',
      toolCallId: 'call-1',
      toolName: 'test-tool',
      input: { private: 'input' },
    });

    expect(recording.sentMessages).toEqual([
      { content: 'mixed-transports follow-up', options: { deliverAs: 'followUp' } },
      { content: 'mixed-transports steer', options: { deliverAs: 'steer' } },
    ]);
    expect(blocked).toEqual({ block: true, reason: 'mixed-transports block' });
  });

  it('keeps Kernel health healthy and the feature active when the budget is exhausted', async () => {
    const id = 'healthy-after-exhaustion';
    const recording = new RecordingPi();
    const kernel = createKernel(recording, [followUpFeature(id)]);

    await recording.emit('input', inputEvent());
    await recording.emit('tool_result', toolResultEvent('call-1'));
    await recording.emit('tool_result', toolResultEvent('call-2'));

    expect(recording.sentMessages).toHaveLength(1);
    expect(kernel.getHealth()).toBe('healthy');
    expect(kernel.getRuntimeStatuses().find((status) => status.id === id)?.status).toBe('active');
    expect(recording.notifications).toEqual([]);
  });
});
