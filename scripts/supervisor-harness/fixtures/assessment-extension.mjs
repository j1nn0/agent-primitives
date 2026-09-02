/* global process */

import { appendFileSync } from 'node:fs';
import { createAgentSupervisorExtension } from '../../../packages/agent-supervisor-pi/dist/extension.js';

const ASSESSMENT_TRACE_ENV = 'SUPERVISOR_HARNESS_ASSESSMENT_TRACE_PATH';
const SIBLING_TRACE_ENV = 'SUPERVISOR_HARNESS_ASSESSMENT_SIBLING_TRACE_PATH';
const ASSESSMENT_KIND = 'kernel:completion-assessment';
const OBSERVER_ID = 'assessment-observer';
const LIFECYCLE_OBSERVER_ID = 'assessment-lifecycle-observer';
const SIBLING_ID = 'assessment-sibling';
const FORBIDDEN_HANDLE_KEYS = ['pi', 'model', 'modelRegistry'];

function tracePath(environmentVariable) {
  const path = process.env[environmentVariable];
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`assessment foundation fixture requires ${environmentVariable}`);
  }
  return path;
}

function appendTrace(environmentVariable, entry) {
  appendFileSync(tracePath(environmentVariable), `${JSON.stringify(entry)}\n`, 'utf8');
}

function assertNoForbiddenHandles(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new Error('assessment foundation fixture received an invalid context');
  }
  if (FORBIDDEN_HANDLE_KEYS.some((key) => key in value)) {
    throw new Error('assessment foundation fixture received a forbidden handle');
  }
}

function copyFact(fact) {
  return {
    id: fact.id,
    sequence: fact.sequence,
    sourceFeatureId: fact.sourceFeatureId,
    rootRequestId: fact.rootRequestId,
    kind: fact.kind,
    evidenceRefs: [...fact.evidenceRefs],
    data: fact.data,
  };
}

/** Test-only consumer; this feature is never included in the production built-in registry. */
export function createAssessmentObserver() {
  return {
    descriptor: {
      id: OBSERVER_ID,
      schemaVersion: 1,
      maturity: 'validated',
      defaultMode: 'autonomous',
      observes: ['assessment-ready'],
      provides: [],
      requires: ['kernel:assessment'],
      conflictsWith: [],
      usesAuxiliaryModel: true,
      interventionIntents: [],
    },
    create(context) {
      assertNoForbiddenHandles(context);
      return {
        onObservation(observation, runtimeContext) {
          assertNoForbiddenHandles(runtimeContext);
          if (observation.kind !== 'assessment-ready') {
            return undefined;
          }

          const assessmentFacts = runtimeContext.facts
            .byKind(ASSESSMENT_KIND)
            .map(copyFact);
          appendTrace(ASSESSMENT_TRACE_ENV, {
            featureId: OBSERVER_ID,
            observationKind: observation.kind,
            observationId: observation.id,
            observationSequence: observation.sequence,
            observationPayload: observation.payload,
            rootRequestId: observation.rootRequestId,
            runtimeContextKeys: Object.keys(runtimeContext).sort(),
            assessmentFacts,
          });
          return undefined;
        },
      };
    },
  };
}

/** Test-only consumer used to record settled-before-ready ordering and fact visibility. */
export function createAssessmentLifecycleObserver() {
  return {
    descriptor: {
      id: LIFECYCLE_OBSERVER_ID,
      schemaVersion: 1,
      maturity: 'validated',
      defaultMode: 'autonomous',
      observes: ['agent-settled'],
      provides: [],
      requires: [],
      conflictsWith: [],
      usesAuxiliaryModel: false,
      interventionIntents: [],
    },
    create(context) {
      assertNoForbiddenHandles(context);
      return {
        onObservation(observation, runtimeContext) {
          assertNoForbiddenHandles(runtimeContext);
          if (observation.kind !== 'agent-settled') {
            return undefined;
          }

          const assessmentFacts = runtimeContext.facts
            .byKind(ASSESSMENT_KIND)
            .map(copyFact);
          appendTrace(ASSESSMENT_TRACE_ENV, {
            featureId: LIFECYCLE_OBSERVER_ID,
            observationKind: observation.kind,
            observationId: observation.id,
            observationSequence: observation.sequence,
            observationPayload: observation.payload,
            rootRequestId: observation.rootRequestId,
            runtimeContextKeys: Object.keys(runtimeContext).sort(),
            assessmentFacts,
          });
          return undefined;
        },
      };
    },
  };
}

/** Test-only sibling used to prove malformed assessment output does not isolate other features. */
export function createAssessmentSibling() {
  return {
    descriptor: {
      id: SIBLING_ID,
      schemaVersion: 1,
      maturity: 'validated',
      defaultMode: 'autonomous',
      observes: ['before-tool-call'],
      provides: [],
      requires: [],
      conflictsWith: [],
      usesAuxiliaryModel: false,
      interventionIntents: [],
    },
    create() {
      return {
        onObservation(observation) {
          if (observation.kind !== 'before-tool-call') {
            return undefined;
          }
          appendTrace(SIBLING_TRACE_ENV, {
            featureId: SIBLING_ID,
            observationKind: observation.kind,
            observationId: observation.id,
            observationSequence: observation.sequence,
            rootRequestId: observation.rootRequestId,
            toolCallId: observation.payload?.toolCallId ?? null,
            toolName: observation.payload?.toolName ?? null,
          });
          return undefined;
        },
      };
    },
  };
}

export function createAssessmentFeatures() {
  return [
    createAssessmentObserver(),
    createAssessmentLifecycleObserver(),
    createAssessmentSibling(),
  ];
}

export default function assessmentFoundationExtension(pi) {
  createAgentSupervisorExtension({ features: createAssessmentFeatures() })(pi);
}
