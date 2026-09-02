import { describe, expect, it } from 'vitest';
import { judgeRetry, type RetryAttempt } from '@j1nn0/agent-retry-guard';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { createSupervisorFactSnapshot } from '../src/fact.js';
import {
  computeRetryLoopFailureFingerprint,
  computeRetryLoopInvocationFingerprint,
  createRetryLoopBreaker,
} from '../src/features/retry-loop-breaker.js';
import { createAgentSupervisorExtension, registerAgentSupervisorExtension } from '../src/extension.js';
import type { SupervisorFeatureEmission, SupervisorFeatureRuntime } from '../src/module.js';
import type { JsonValue } from '../src/json.js';
import type { SupervisorObservation, SupervisorObservationKind } from '../src/observation.js';

const ROOT_ID = 'root-1';
const TOOL_NAME = 'target-tool';
const INPUT_DIGEST = 'input-a';
const RESULT_DIGEST = 'result-a';
const STEER_MESSAGE =
  'Agent Supervisor: the same tool invocation has failed twice with the same result. Do not repeat it unchanged; investigate the cause or use a different invocation.';
const BLOCK_MESSAGE =
  'Agent Supervisor: this exact tool invocation already failed twice with the same result. Change strategy before retrying it unchanged.';

type OnObservation = NonNullable<SupervisorFeatureRuntime<never>['onObservation']>;

type EventHandler = (event: unknown, context: ExtensionContext) => Promise<unknown> | unknown;
type CommandHandler = (args: string, context: ExtensionCommandContext) => Promise<void>;

interface SentMessage {
  readonly content: unknown;
  readonly options: unknown;
}

interface Notification {
  readonly message: string;
  readonly type: string | undefined;
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
  public readonly notifications: Notification[] = [];
  public readonly appendedEntries: { customType: string; data: unknown }[] = [];
  public registerToolCalls = 0;
  public readonly pi: ExtensionAPI;
  private readonly branch: SessionEntry[];

  public constructor(initialBranch: readonly SessionEntry[] = []) {
    this.branch = [...initialBranch];
    this.pi = {
      on: (event: string, handler: unknown): void => {
        this.handlers.set(event, handler as EventHandler);
      },
      registerCommand: (name: string, options: { handler: CommandHandler }): void => {
        this.commands.set(name, options.handler);
      },
      registerTool: (): void => {
        this.registerToolCalls += 1;
      },
      appendEntry: (customType: string, data?: unknown): void => {
        this.appendedEntries.push({ customType, data });
        this.branch.push(customEntry(customType, data));
      },
      sendUserMessage: (content: unknown, options?: unknown): void => {
        this.sentMessages.push({ content, options });
      },
    } as unknown as ExtensionAPI;
  }

  public context(): ExtensionContext {
    return {
      ui: {
        notify: (message: string, type?: 'info' | 'warning' | 'error'): void => {
          this.notifications.push({ message, type });
        },
      },
      sessionManager: {
        getBranch: (): SessionEntry[] => this.branch,
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

  public async command(args: string): Promise<void> {
    const handler = this.commands.get('agent-supervisor');
    if (handler === undefined) {
      throw new Error('Supervisor command was not registered.');
    }
    await handler(args, this.context() as unknown as ExtensionCommandContext);
  }
}

let nextObservationSequence = 0;

function observation(
  kind: SupervisorObservationKind,
  payload: JsonValue,
  rootRequestId: string | null = ROOT_ID,
): SupervisorObservation {
  const sequence = nextObservationSequence;
  nextObservationSequence += 1;
  return {
    schemaVersion: 1,
    id: `test-observation-${sequence}`,
    sequence,
    rootRequestId,
    kind,
    payload,
  };
}

function rootStarted(rootRequestId = ROOT_ID): SupervisorObservation {
  return observation('root-request-started', { source: 'interactive' }, rootRequestId);
}

function beforeToolCall(
  inputDigest: string | null = INPUT_DIGEST,
  toolName = TOOL_NAME,
  toolCallId = 'call-1',
  rootRequestId: string | null = ROOT_ID,
): SupervisorObservation {
  return observation(
    'before-tool-call',
    { toolCallId, toolName, inputDigest },
    rootRequestId,
  );
}

function toolResult(
  options: {
    readonly inputDigest?: string | null;
    readonly resultDigest?: string | null;
    readonly isError?: boolean;
    readonly toolName?: string;
    readonly toolCallId?: string;
  } = {},
  rootRequestId: string | null = ROOT_ID,
): SupervisorObservation {
  return observation(
    'tool-result',
    {
      toolCallId: options.toolCallId ?? 'call-1',
      toolName: options.toolName ?? TOOL_NAME,
      inputDigest: options.inputDigest === undefined ? INPUT_DIGEST : options.inputDigest,
      isError: options.isError ?? true,
      resultDigest: options.resultDigest === undefined ? RESULT_DIGEST : options.resultDigest,
    },
    rootRequestId,
  );
}

function directRuntime(): OnObservation {
  const runtime = createRetryLoopBreaker().create({
    featureId: 'retry-loop-breaker',
    config: null,
    initialState: null,
    effectiveMode: 'autonomous',
  });
  if (runtime.onObservation === undefined) {
    throw new Error('Retry loop breaker did not create an observation runtime.');
  }
  return runtime.onObservation;
}

function directContext() {
  return {
    featureId: 'retry-loop-breaker',
    effectiveMode: 'autonomous' as const,
    facts: createSupervisorFactSnapshot([]),
    state: null,
  };
}

async function send(
  runtime: OnObservation,
  nextObservation: SupervisorObservation,
): Promise<SupervisorFeatureEmission<never> | undefined> {
  const emission = await runtime(nextObservation, directContext());
  return emission === undefined ? undefined : emission;
}

function inputEvent(source: 'interactive' | 'rpc' | 'extension' = 'interactive'): unknown {
  return { type: 'input', source, text: 'private prompt' };
}

function toolCallEvent(
  toolCallId = 'call-1',
  input: unknown = { value: 1 },
  toolName = TOOL_NAME,
): unknown {
  return { type: 'tool_call', toolCallId, toolName, input };
}

function toolResultEvent(
  toolCallId = 'call-1',
  input: unknown = { value: 1 },
  content: unknown = [{ type: 'text', text: 'same error' }],
  isError = true,
  toolName = TOOL_NAME,
): unknown {
  return {
    type: 'tool_result',
    toolCallId,
    toolName,
    input,
    content,
    isError,
    details: { private: 'details' },
  };
}

async function emitIdenticalFailures(recording: RecordingPi): Promise<void> {
  await recording.emit('input', inputEvent());
  await recording.emit('tool_result', toolResultEvent());
  await recording.emit('tool_result', toolResultEvent());
}

describe('retry-loop-breaker identity and Retry Guard integration', () => {
  it('uses exact tool, input, and result identity for fingerprints', () => {
    const same = computeRetryLoopFailureFingerprint(TOOL_NAME, INPUT_DIGEST, RESULT_DIGEST);
    expect(same).not.toBeNull();
    expect(computeRetryLoopFailureFingerprint(TOOL_NAME, INPUT_DIGEST, RESULT_DIGEST)).toBe(same);
    expect(computeRetryLoopFailureFingerprint('other-tool', INPUT_DIGEST, RESULT_DIGEST)).not.toBe(same);
    expect(computeRetryLoopFailureFingerprint(TOOL_NAME, 'input-b', RESULT_DIGEST)).not.toBe(same);
    expect(computeRetryLoopFailureFingerprint(TOOL_NAME, INPUT_DIGEST, 'result-b')).not.toBe(same);
    expect(computeRetryLoopInvocationFingerprint(TOOL_NAME, null)).toBeNull();
    expect(computeRetryLoopFailureFingerprint(TOOL_NAME, null, RESULT_DIGEST)).toBeNull();
    expect(computeRetryLoopFailureFingerprint(TOOL_NAME, INPUT_DIGEST, null)).toBeNull();
  });

  it('gets the expected real Retry Guard verdict before and at the strategy limit', () => {
    const strategyId = computeRetryLoopFailureFingerprint(TOOL_NAME, INPUT_DIGEST, RESULT_DIGEST);
    if (strategyId === null) {
      throw new Error('Expected an exact failure fingerprint.');
    }
    const firstAttempt: RetryAttempt = { outcome: 'failure', strategyId };
    const first = judgeRetry({
      attempts: [firstAttempt],
      policy: { maxStrategyAttempts: 2 },
    });
    const second = judgeRetry({
      attempts: [firstAttempt, firstAttempt],
      policy: { maxStrategyAttempts: 2 },
    });

    expect(first).toEqual({
      attempts: 1,
      consecutiveFailures: 1,
      consecutiveNoProgress: 0,
      strategyRun: { strategyId, attempts: 1 },
      retryAllowed: true,
    });
    expect(second).toEqual({
      attempts: 2,
      consecutiveFailures: 2,
      consecutiveNoProgress: 0,
      strategyRun: { strategyId, attempts: 2 },
      retryAllowed: false,
    });
  });

  it('does not steer after one failure and arms with one steer after the second', async () => {
    const runtime = directRuntime();
    await send(runtime, rootStarted());

    expect(await send(runtime, toolResult())).toBeUndefined();
    const second = await send(runtime, toolResult());
    expect(second).toEqual({
      interventions: [
        {
          sourceFeatureId: 'retry-loop-breaker',
          boundary: 'stream',
          intent: 'change-strategy',
          delivery: 'steer',
          priority: 100,
          reasonCode: 'retry-loop-breaker:repeated-failure',
          message: STEER_MESSAGE,
        },
      ],
    });
    expect(await send(runtime, toolResult())).toBeUndefined();

    expect(await send(runtime, beforeToolCall(INPUT_DIGEST, TOOL_NAME, 'call-3'))).toEqual({
      interventions: [
        {
          sourceFeatureId: 'retry-loop-breaker',
          boundary: 'tool-call',
          intent: 'stop',
          delivery: 'block',
          priority: 100,
          reasonCode: 'retry-loop-breaker:unchanged-retry-blocked',
          message: BLOCK_MESSAGE,
          targetToolCallId: 'call-3',
        },
      ],
    });
    expect(await send(runtime, beforeToolCall(INPUT_DIGEST, TOOL_NAME, 'call-4'))).toEqual({
      interventions: [
        {
          sourceFeatureId: 'retry-loop-breaker',
          boundary: 'tool-call',
          intent: 'stop',
          delivery: 'block',
          priority: 100,
          reasonCode: 'retry-loop-breaker:unchanged-retry-blocked',
          message: BLOCK_MESSAGE,
          targetToolCallId: 'call-4',
        },
      ],
    });
  });

  it('resets all episode state at a new root request', async () => {
    const runtime = directRuntime();
    await send(runtime, rootStarted('root-1'));
    await send(runtime, toolResult());
    await send(runtime, toolResult());
    expect(await send(runtime, beforeToolCall())).not.toBeUndefined();

    await send(runtime, rootStarted('root-2'));
    expect(await send(runtime, beforeToolCall())).toBeUndefined();
    expect(await send(runtime, toolResult())).toBeUndefined();
    expect(await send(runtime, toolResult())).toMatchObject({
      interventions: [{ reasonCode: 'retry-loop-breaker:repeated-failure' }],
    });
  });

  it('keeps distinct failures, successes, and executed invocations from arming', async () => {
    const distinctFailureRuntime = directRuntime();
    await send(distinctFailureRuntime, rootStarted());
    await send(distinctFailureRuntime, toolResult({ resultDigest: 'result-a' }));
    await send(distinctFailureRuntime, toolResult({ resultDigest: 'result-b' }));
    expect(await send(distinctFailureRuntime, beforeToolCall())).toBeUndefined();

    const successRuntime = directRuntime();
    await send(successRuntime, rootStarted());
    await send(successRuntime, toolResult({ resultDigest: 'result-a' }));
    await send(successRuntime, toolResult({ isError: false, resultDigest: 'success' }));
    await send(successRuntime, toolResult({ resultDigest: 'result-a' }));
    expect(await send(successRuntime, beforeToolCall())).toBeUndefined();

    const differentInvocationRuntime = directRuntime();
    await send(differentInvocationRuntime, rootStarted());
    await send(differentInvocationRuntime, toolResult({ toolName: 'tool-a' }));
    await send(differentInvocationRuntime, toolResult({ toolName: 'tool-b', isError: false }));
    await send(differentInvocationRuntime, toolResult({ toolName: 'tool-a' }));
    expect(await send(differentInvocationRuntime, beforeToolCall(INPUT_DIGEST, 'tool-a'))).toBeUndefined();
  });

  it('treats incomplete identity and unknown attempts as streak breaks', async () => {
    const nullInputRuntime = directRuntime();
    await send(nullInputRuntime, rootStarted());
    await send(nullInputRuntime, toolResult({ inputDigest: null }));
    await send(nullInputRuntime, toolResult({ inputDigest: null }));
    expect(await send(nullInputRuntime, beforeToolCall(null))).toBeUndefined();

    const nullResultRuntime = directRuntime();
    await send(nullResultRuntime, rootStarted());
    await send(nullResultRuntime, toolResult({ resultDigest: null }));
    await send(nullResultRuntime, toolResult({ resultDigest: null }));
    expect(await send(nullResultRuntime, beforeToolCall())).toBeUndefined();

    const unknownBreakRuntime = directRuntime();
    await send(unknownBreakRuntime, rootStarted());
    await send(unknownBreakRuntime, toolResult({ resultDigest: 'result-a' }));
    await send(unknownBreakRuntime, toolResult({ resultDigest: null }));
    await send(unknownBreakRuntime, toolResult({ resultDigest: 'result-a' }));
    expect(await send(unknownBreakRuntime, beforeToolCall())).toBeUndefined();
  });

  it('does not disarm for a different before call, but disarms after its executed result', async () => {
    const blockedRuntime = directRuntime();
    await send(blockedRuntime, rootStarted());
    await send(blockedRuntime, toolResult());
    await send(blockedRuntime, toolResult());
    expect(await send(blockedRuntime, beforeToolCall(INPUT_DIGEST, 'tool-b', 'call-b'))).toBeUndefined();
    expect(await send(blockedRuntime, beforeToolCall(INPUT_DIGEST, TOOL_NAME, 'call-a'))).toMatchObject({
      interventions: [{ delivery: 'block', targetToolCallId: 'call-a' }],
    });

    const disarmedRuntime = directRuntime();
    await send(disarmedRuntime, rootStarted());
    await send(disarmedRuntime, toolResult());
    await send(disarmedRuntime, toolResult());
    await send(disarmedRuntime, toolResult({ toolName: 'tool-b', isError: false }));
    expect(await send(disarmedRuntime, beforeToolCall())).toBeUndefined();
  });

  it('fails open for observations without a root request', async () => {
    const runtime = directRuntime();
    expect(await send(runtime, rootStarted('root-1'))).toBeUndefined();
    expect(await send(runtime, toolResult({}, null))).toBeUndefined();
    expect(await send(runtime, toolResult({}, null))).toBeUndefined();
    expect(await send(runtime, beforeToolCall(INPUT_DIGEST, TOOL_NAME, 'call-null', null))).toBeUndefined();
  });
});

describe('retry-loop-breaker through the Supervisor Kernel', () => {
  it('uses the production autonomous default and transports exactly one steer', async () => {
    const recording = new RecordingPi();
    registerAgentSupervisorExtension(recording.pi);

    await emitIdenticalFailures(recording);
    expect(recording.sentMessages).toEqual([{ content: STEER_MESSAGE, options: { deliverAs: 'steer' } }]);
    expect(await recording.emit('tool_call', toolCallEvent('call-3'))).toEqual({
      block: true,
      reason: BLOCK_MESSAGE,
    });
    expect(recording.sentMessages).toHaveLength(1);
    expect(recording.registerToolCalls).toBe(0);
  });

  it('keeps an explicit factory isolated from production built-ins', async () => {
    const recording = new RecordingPi();
    createAgentSupervisorExtension({ features: [] })(recording.pi);
    await recording.command('status');
    expect(recording.notifications.at(-1)?.message).toContain('Registered features: 0');
  });

  it('keeps feature observe proposals observed-only without Pi transport', async () => {
    const recording = new RecordingPi();
    registerAgentSupervisorExtension(recording.pi);
    await recording.command('feature retry-loop-breaker observe');

    await emitIdenticalFailures(recording);
    expect(recording.sentMessages).toHaveLength(0);
    expect(await recording.emit('tool_call', toolCallEvent('call-observe'))).toBeUndefined();
  });

  it('does not instantiate or execute the feature when it is off', async () => {
    const recording = new RecordingPi();
    registerAgentSupervisorExtension(recording.pi);
    await recording.command('feature retry-loop-breaker off');
    await recording.command('status');
    expect(recording.notifications.at(-1)?.message).toContain(
      '- retry-loop-breaker: maturity=validated, default=autonomous, requested=off, effective=off, runtime=off, status=off',
    );

    await emitIdenticalFailures(recording);
    expect(recording.sentMessages).toHaveLength(0);
    expect(await recording.emit('tool_call', toolCallEvent('call-off'))).toBeUndefined();
  });

  it('suppresses transport when the global mode is observe', async () => {
    const recording = new RecordingPi();
    registerAgentSupervisorExtension(recording.pi);
    await recording.command('mode observe');

    await emitIdenticalFailures(recording);
    expect(recording.sentMessages).toHaveLength(0);
    expect(await recording.emit('tool_call', toolCallEvent('call-global-observe'))).toBeUndefined();
  });
});
