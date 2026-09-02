/* global process */
import { appendFileSync } from 'node:fs';
import { createAgentSupervisorExtension } from '../../../packages/agent-supervisor-pi/dist/extension.js';
import createRetryLoopBreaker from '../../../packages/agent-supervisor-pi/dist/features/retry-loop-breaker.js';

const TARGET_TOOL_NAME = 'supervisor_harness_retry_loop_coexistence_target';
const TRACE_ENV = 'SUPERVISOR_HARNESS_RETRY_LOOP_COEXISTENCE_TRACE_PATH';
const COMPANION_FEATURE_ID = 'aaa-one-shot-pass-through';
const COMPANION_REASON_CODE = `${COMPANION_FEATURE_ID}:third-target-call`;

function tracePath() {
  const path = process.env[TRACE_ENV];
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`retry-loop-breaker coexistence probe requires ${TRACE_ENV}`);
  }
  return path;
}

function appendTrace(entry) {
  appendFileSync(tracePath(), `${JSON.stringify(entry)}\n`, 'utf8');
}

/** Test-only arbitration companion; this is never part of the production built-in registry. */
export function createOneShotPassThrough() {
  return {
    descriptor: {
      id: COMPANION_FEATURE_ID,
      schemaVersion: 1,
      maturity: 'validated',
      defaultMode: 'autonomous',
      observes: ['before-tool-call'],
      provides: [],
      requires: [],
      conflictsWith: [],
      usesAuxiliaryModel: false,
      interventionIntents: ['stop'],
    },
    create() {
      let targetCallNumber = 0;

      return {
        onObservation(observation) {
          if (
            observation.kind !== 'before-tool-call' ||
            observation.payload?.toolName !== TARGET_TOOL_NAME
          ) {
            return undefined;
          }

          targetCallNumber += 1;
          const toolCallId = observation.payload?.toolCallId;
          const proposed = targetCallNumber === 3;
          appendTrace({
            featureId: COMPANION_FEATURE_ID,
            action: 'target-observed',
            targetCallNumber,
            proposed,
            toolCallId: typeof toolCallId === 'string' ? toolCallId : null,
            rootRequestId: observation.rootRequestId,
          });

          if (!proposed || typeof toolCallId !== 'string' || toolCallId.length === 0) {
            return undefined;
          }

          return {
            interventions: [
              {
                sourceFeatureId: COMPANION_FEATURE_ID,
                boundary: 'tool-call',
                intent: 'stop',
                delivery: 'none',
                priority: 100,
                reasonCode: COMPANION_REASON_CODE,
                targetToolCallId: toolCallId,
              },
            ],
          };
        },
      };
    },
  };
}

export default function retryLoopBreakerCoexistenceExtension(pi) {
  const companion = createOneShotPassThrough();
  createAgentSupervisorExtension({
    features: [createRetryLoopBreaker(), companion],
  })(pi);
}
