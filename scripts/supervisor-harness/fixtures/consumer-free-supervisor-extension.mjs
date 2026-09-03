/* global process */

import { appendFileSync } from 'node:fs';
import { createAgentSupervisorExtension } from '../../../packages/agent-supervisor-pi/dist/extension.js';

const TRACE_ENV = 'SUPERVISOR_HARNESS_CONSUMER_FREE_TRACE_PATH';
const FEATURE_ID = 'consumer-free-observer';

function tracePath() {
  const path = process.env[TRACE_ENV];
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`consumer-free Supervisor fixture requires ${TRACE_ENV}`);
  }
  return path;
}

function createConsumerFreeObserver() {
  return {
    descriptor: {
      id: FEATURE_ID,
      schemaVersion: 1,
      maturity: 'validated',
      defaultMode: 'autonomous',
      observes: ['agent-settled', 'assessment-ready'],
      provides: [],
      requires: [],
      conflictsWith: [],
      usesAuxiliaryModel: false,
      interventionIntents: [],
    },
    create: () => ({
      onObservation(observation) {
        if (observation.kind === 'agent-settled' || observation.kind === 'assessment-ready') {
          appendFileSync(
            tracePath(),
            `${JSON.stringify({ observationKind: observation.kind })}\n`,
            'utf8',
          );
        }
        return undefined;
      },
    }),
  };
}

/** A public Supervisor factory with an observer but no assessment-requiring feature. */
export function createConsumerFreeSupervisor() {
  return (pi) => {
    createAgentSupervisorExtension({ features: [createConsumerFreeObserver()] })(pi);
  };
}

export default function consumerFreeSupervisorExtension(pi) {
  createConsumerFreeSupervisor()(pi);
}
