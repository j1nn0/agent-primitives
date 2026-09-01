/* global process */
import {
  createAgentSupervisorExtension,
} from '../../../packages/agent-supervisor-pi/dist/extension.js';
import { appendFileSync } from 'node:fs';

/*
 * Probe profiles:
 * - blocker: registers probe-blocker (the profile used by kernel-runtime-probe).
 * - observer: registers probe-observer.
 * - fact-visibility: registers probe-fact-emitter and probe-fact-reader.
 * - failure-isolation: registers a throwing feature and a healthy sibling.
 * - feature-config-semantics: registers a semantically validated feature and a healthy sibling.
 */
const FACT_TRACE_ENV = 'SUPERVISOR_HARNESS_FACT_TRACE_PATH';
const FACT_EMITTER_ID = 'probe-fact-emitter';
const FACT_READER_ID = 'probe-fact-reader';
const FACT_KIND = `${FACT_EMITTER_ID}:signal`;
const FACT_MARKER = 'supervisor-harness-fact-visibility';
const FAILURE_TRACE_ENV = 'SUPERVISOR_HARNESS_FAILURE_TRACE_PATH';
const FAILURE_FEATURE_ID = 'probe-failing-feature';
const HEALTHY_FEATURE_ID = 'probe-healthy-sibling';

function factTracePath() {
  const path = process.env[FACT_TRACE_ENV];
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`fact-visibility probe requires ${FACT_TRACE_ENV}`);
  }
  return path;
}

function failureTracePath() {
  const path = process.env[FAILURE_TRACE_ENV];
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`failure-isolation probe requires ${FAILURE_TRACE_ENV}`);
  }
  return path;
}

function appendFailureTrace(entry) {
  appendFileSync(failureTracePath(), `${JSON.stringify(entry)}\n`, 'utf8');
}

const FORBIDDEN_PI_KEYS = [
  'pi',
  'ctx',
  'sendUserMessage',
  'appendEntry',
  'registerTool',
  'registerCommand',
  'on',
];

function hasNoPiHandle(value) {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return false;
  }
  return FORBIDDEN_PI_KEYS.every((key) => !(key in value));
}

const probeBlocker = {
  descriptor: {
    id: 'probe-blocker',
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
  create(context) {
    const createReport = hasNoPiHandle(context)
      ? 'create-context-isolated'
      : 'create-context-exposed';
    return {
      onObservation(observation, runtimeContext) {
        if (observation.kind !== 'before-tool-call') {
          return undefined;
        }
        const toolCallId = observation.payload?.toolCallId;
        if (typeof toolCallId !== 'string') {
          return undefined;
        }
        const runtimeReport = hasNoPiHandle(runtimeContext)
          ? 'runtime-context-isolated'
          : 'runtime-context-exposed';
        return {
          interventions: [
            {
              sourceFeatureId: 'probe-blocker',
              boundary: 'tool-call',
              intent: 'stop',
              delivery: 'block',
              priority: 100,
              reasonCode: 'probe-blocker:tool-call-blocked',
              message: [
                'probe-blocker proposal won at the tool-call boundary',
                'probe-blocker-reason',
                createReport,
                runtimeReport,
              ].join('; '),
              targetToolCallId: toolCallId,
            },
          ],
        };
      },
    };
  },
};

const probeFactEmitter = {
  descriptor: {
    id: FACT_EMITTER_ID,
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
        return {
          facts: [
            {
              kind: FACT_KIND,
              evidenceRefs: ['probe-fact-visibility:emitted'],
              data: { marker: FACT_MARKER },
            },
          ],
        };
      },
    };
  },
};

const probeFactReader = {
  descriptor: {
    id: FACT_READER_ID,
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
      onObservation(observation, runtimeContext) {
        if (observation.kind !== 'before-tool-call') {
          return undefined;
        }
        const facts = runtimeContext.facts.all().map((fact) => ({
          id: fact.id,
          sequence: fact.sequence,
          sourceFeatureId: fact.sourceFeatureId,
          rootRequestId: fact.rootRequestId,
          kind: fact.kind,
          evidenceRefs: [...fact.evidenceRefs],
          data: fact.data,
        }));
        appendFileSync(
          factTracePath(),
          `${JSON.stringify({
            observationId: observation.id,
            observationSequence: observation.sequence,
            rootRequestId: observation.rootRequestId,
            toolCallId: observation.payload?.toolCallId ?? null,
            facts,
          })}\n`,
          'utf8',
        );
        return undefined;
      },
    };
  },
};

const probeObserver = {
  descriptor: {
    id: 'probe-observer',
    schemaVersion: 1,
    maturity: 'validated',
    defaultMode: 'observe',
    observes: ['before-tool-call'],
    provides: [],
    requires: [],
    conflictsWith: [],
    usesAuxiliaryModel: false,
    interventionIntents: [],
  },
  create() {
    return {
      onObservation: () => undefined,
    };
  },
};

const probeFailingFeature = {
  descriptor: {
    id: FAILURE_FEATURE_ID,
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
    let observationCount = 0;
    return {
      onObservation(observation) {
        if (observation.kind !== 'before-tool-call') {
          return undefined;
        }
        observationCount += 1;
        const toolCallId = observation.payload?.toolCallId;
        if (observationCount === 1) {
          appendFailureTrace({
            featureId: FAILURE_FEATURE_ID,
            action: 'throw',
            observationId: observation.id,
            observationSequence: observation.sequence,
            toolCallId: typeof toolCallId === 'string' ? toolCallId : null,
          });
          throw new Error('deliberate probe observation failure');
        }
        appendFailureTrace({
          featureId: FAILURE_FEATURE_ID,
          action: 'would-intervene',
          observationId: observation.id,
          observationSequence: observation.sequence,
          toolCallId: typeof toolCallId === 'string' ? toolCallId : null,
        });
        if (typeof toolCallId !== 'string') {
          return undefined;
        }
        return {
          interventions: [
            {
              sourceFeatureId: FAILURE_FEATURE_ID,
              boundary: 'tool-call',
              intent: 'stop',
              delivery: 'block',
              priority: 100,
              reasonCode: 'probe-failing-feature:post-failure-stop',
              message: 'probe-failing-feature would have blocked this later tool call',
              targetToolCallId: toolCallId,
            },
          ],
        };
      },
    };
  },
};

const probeHealthySibling = {
  descriptor: {
    id: HEALTHY_FEATURE_ID,
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
        const toolCallId = observation.payload?.toolCallId;
        appendFailureTrace({
          featureId: HEALTHY_FEATURE_ID,
          action: 'healthy-observed',
          observationId: observation.id,
          observationSequence: observation.sequence,
          toolCallId: typeof toolCallId === 'string' ? toolCallId : null,
        });
        return undefined;
      },
    };
  },
};

const CONFIG_SEMANTICS_TRACE_ENV = 'SUPERVISOR_HARNESS_CONFIG_SEMANTICS_TRACE_PATH';
const CONFIG_VALIDATING_FEATURE_ID = 'probe-config-validating';
const CONFIG_HEALTHY_FEATURE_ID = 'probe-config-healthy';
const ACCEPTED_CONFIG_FLAVOR = 'accepted';

function configSemanticsTracePath() {
  const path = process.env[CONFIG_SEMANTICS_TRACE_ENV];
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`feature-config-semantics probe requires ${CONFIG_SEMANTICS_TRACE_ENV}`);
  }
  return path;
}

function appendConfigSemanticsTrace(entry) {
  appendFileSync(configSemanticsTracePath(), `${JSON.stringify(entry)}\n`, 'utf8');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateConfigSemantics(settings) {
  if (
    !isRecord(settings) ||
    Object.keys(settings).length !== 1 ||
    settings.flavor !== ACCEPTED_CONFIG_FLAVOR
  ) {
    throw new Error('invalid feature configuration');
  }
  return { flavor: settings.flavor };
}

const probeConfigValidatingFeature = {
  descriptor: {
    id: CONFIG_VALIDATING_FEATURE_ID,
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
  validateConfig(settings) {
    return validateConfigSemantics(settings);
  },
  create(context) {
    return {
      onObservation(observation) {
        if (observation.kind !== 'before-tool-call') {
          return undefined;
        }
        const toolCallId = observation.payload?.toolCallId;
        appendConfigSemanticsTrace({
          featureId: CONFIG_VALIDATING_FEATURE_ID,
          action: 'validating-observed',
          configFlavor: context.config?.flavor ?? null,
          toolCallId: typeof toolCallId === 'string' ? toolCallId : null,
        });
        return undefined;
      },
    };
  },
};

const probeConfigHealthySibling = {
  descriptor: {
    id: CONFIG_HEALTHY_FEATURE_ID,
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
        const toolCallId = observation.payload?.toolCallId;
        appendConfigSemanticsTrace({
          featureId: CONFIG_HEALTHY_FEATURE_ID,
          action: 'healthy-observed',
          toolCallId: typeof toolCallId === 'string' ? toolCallId : null,
        });
        return undefined;
      },
    };
  },
};

const profiles = {
  blocker: [probeBlocker],
  observer: [probeObserver],
  'fact-visibility': [probeFactEmitter, probeFactReader],
  'failure-isolation': [probeFailingFeature, probeHealthySibling],
  'feature-config-semantics': [probeConfigValidatingFeature, probeConfigHealthySibling],
};

// Resolve the profile when Pi invokes the extension so sequential isolated sessions can select
// different fixture profiles without relying on module-cache behavior.
export default function probeExtension(pi) {
  const profile = process.env.SUPERVISOR_HARNESS_PROBE_PROFILE ?? 'blocker';
  const features = profiles[profile];
  if (features === undefined) {
    throw new Error(`unknown supervisor harness probe profile: ${profile}`);
  }
  createAgentSupervisorExtension({ features })(pi);
}
