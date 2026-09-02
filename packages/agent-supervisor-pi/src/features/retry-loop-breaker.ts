import { judgeRetry, type RetryAttempt } from '@j1nn0/agent-retry-guard';
import { computeSupervisorJsonDigest } from '../digest.js';
import { isPlainObject } from '../internal.js';
import type {
  SupervisorFeatureEmission,
  SupervisorFeatureModule,
} from '../module.js';
import type { SupervisorObservation } from '../observation.js';

const FEATURE_ID = 'retry-loop-breaker';
const RETRY_POLICY = Object.freeze({ maxStrategyAttempts: 2 });

const STEER_MESSAGE =
  'Agent Supervisor: the same tool invocation has failed twice with the same result. Do not repeat it unchanged; investigate the cause or use a different invocation.';
const BLOCK_MESSAGE =
  'Agent Supervisor: this exact tool invocation already failed twice with the same result. Change strategy before retrying it unchanged.';

interface ToolInvocation {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly inputDigest: string | null;
}

interface ToolResultObservation extends ToolInvocation {
  readonly isError: boolean;
  readonly resultDigest: string | null;
}

/** Returns no fingerprint when the invocation cannot be identified exactly. */
export function computeRetryLoopInvocationFingerprint(
  toolName: string,
  inputDigest: string | null,
): string | null {
  if (inputDigest === null) {
    return null;
  }
  return computeSupervisorJsonDigest({ toolName, inputDigest });
}

/** Returns no fingerprint when either part of the exact failure identity is absent. */
export function computeRetryLoopFailureFingerprint(
  toolName: string,
  inputDigest: string | null,
  resultDigest: string | null,
): string | null {
  const invocationFingerprint = computeRetryLoopInvocationFingerprint(toolName, inputDigest);
  if (invocationFingerprint === null || resultDigest === null) {
    return null;
  }
  return computeSupervisorJsonDigest({ invocationFingerprint, resultDigest });
}

function readToolInvocation(value: unknown): ToolInvocation | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const toolCallId = value.toolCallId;
  const toolName = value.toolName;
  const inputDigest = value.inputDigest;
  if (
    typeof toolCallId !== 'string' ||
    typeof toolName !== 'string' ||
    (inputDigest !== null && typeof inputDigest !== 'string')
  ) {
    return undefined;
  }

  return { toolCallId, toolName, inputDigest };
}

function readToolResult(value: unknown): ToolResultObservation | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const invocation = readToolInvocation(value);
  const isError = value.isError;
  const resultDigest = value.resultDigest;
  if (
    invocation === undefined ||
    typeof isError !== 'boolean' ||
    (resultDigest !== null && typeof resultDigest !== 'string')
  ) {
    return undefined;
  }

  return { ...invocation, isError, resultDigest };
}

const RETRY_LOOP_BREAKER_DESCRIPTOR = {
  id: FEATURE_ID,
  schemaVersion: 1,
  maturity: 'validated',
  defaultMode: 'autonomous',
  observes: ['root-request-started', 'before-tool-call', 'tool-result'],
  requires: ['kernel:observation', 'kernel:intervention'],
  provides: [],
  conflictsWith: [],
  usesAuxiliaryModel: false,
  interventionIntents: ['change-strategy', 'stop'],
} as const;

export function createRetryLoopBreaker(): SupervisorFeatureModule {
  return {
    descriptor: RETRY_LOOP_BREAKER_DESCRIPTOR,
    create: () => {
      let attempts: RetryAttempt[] = [];
      let armedInvocationFingerprint: string | null = null;
      let steered = false;

      const resetEpisode = (): void => {
        attempts = [];
        armedInvocationFingerprint = null;
        steered = false;
      };

      const disarm = (): void => {
        armedInvocationFingerprint = null;
        steered = false;
      };

      const recordAttempt = (attempt: RetryAttempt): ReturnType<typeof judgeRetry> => {
        attempts = [...attempts, attempt].slice(-2);
        return judgeRetry({ attempts, policy: RETRY_POLICY });
      };

      const onObservation = (
        observation: SupervisorObservation,
      ): SupervisorFeatureEmission<never> | undefined => {
        if (observation.rootRequestId === null) {
          return undefined;
        }

        if (observation.kind === 'root-request-started') {
          resetEpisode();
          return undefined;
        }

        if (observation.kind === 'before-tool-call') {
          const invocation = readToolInvocation(observation.payload);
          const invocationFingerprint =
            invocation === undefined
              ? null
              : computeRetryLoopInvocationFingerprint(invocation.toolName, invocation.inputDigest);
          if (
            invocation === undefined ||
            invocation.toolCallId.length === 0 ||
            invocationFingerprint === null ||
            armedInvocationFingerprint !== invocationFingerprint
          ) {
            return undefined;
          }

          return {
            interventions: [
              {
                sourceFeatureId: FEATURE_ID,
                boundary: 'tool-call',
                intent: 'stop',
                delivery: 'block',
                priority: 100,
                reasonCode: 'retry-loop-breaker:unchanged-retry-blocked',
                message: BLOCK_MESSAGE,
                targetToolCallId: invocation.toolCallId,
              },
            ],
          };
        }

        if (observation.kind !== 'tool-result') {
          return undefined;
        }

        const result = readToolResult(observation.payload);
        if (result === undefined) {
          return undefined;
        }

        const invocationFingerprint = computeRetryLoopInvocationFingerprint(
          result.toolName,
          result.inputDigest,
        );
        if (
          armedInvocationFingerprint !== null &&
          invocationFingerprint !== null &&
          invocationFingerprint !== armedInvocationFingerprint
        ) {
          disarm();
        }

        if (!result.isError) {
          recordAttempt({ outcome: 'success' });
          return undefined;
        }

        const failureFingerprint = computeRetryLoopFailureFingerprint(
          result.toolName,
          result.inputDigest,
          result.resultDigest,
        );
        const attempt: RetryAttempt =
          failureFingerprint === null
            ? { outcome: 'unknown' }
            : { outcome: 'failure', strategyId: failureFingerprint };
        const verdict = recordAttempt(attempt);

        if (
          attempt.outcome !== 'failure' ||
          invocationFingerprint === null ||
          failureFingerprint === null ||
          verdict.strategyRun === undefined ||
          verdict.strategyRun.strategyId !== failureFingerprint ||
          verdict.strategyRun.attempts < 2 ||
          verdict.retryAllowed
        ) {
          return undefined;
        }

        armedInvocationFingerprint = invocationFingerprint;
        if (steered) {
          return undefined;
        }
        steered = true;
        return {
          interventions: [
            {
              sourceFeatureId: FEATURE_ID,
              boundary: 'stream',
              intent: 'change-strategy',
              delivery: 'steer',
              priority: 100,
              reasonCode: 'retry-loop-breaker:repeated-failure',
              message: STEER_MESSAGE,
            },
          ],
        };
      };

      return { onObservation };
    },
  };
}

export default createRetryLoopBreaker;
