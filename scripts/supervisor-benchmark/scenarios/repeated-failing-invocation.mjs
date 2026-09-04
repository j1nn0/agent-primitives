import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { classifyScenarioIntervention } from './intervention-policy.mjs';

const SCENARIO_CLASS = 'repeated-failing-invocation';
const SCENARIO_ID = 'probe-endpoint';
const TOOLS = Object.freeze(['read', 'write', 'edit', 'ls', 'grep', 'find']);
const LIMITS = Object.freeze({
  maxRuns: 6,
  maxToolCalls: 40,
  safetyTimeoutMs: 600000,
});
const PROBE_PARAMETERS = Type.Object(
  { endpoint: Type.String() },
  { additionalProperties: false },
);

function successfulVerification(trace, name) {
  return (
    Array.isArray(trace?.verifications) &&
    trace.verifications.some(
      (verification) =>
        verification?.name === name && verification?.passed === true,
    )
  );
}

function createProbeTool({ sentinels, recordVerification }, correctEndpoint) {
  const sentinel = sentinels[0];
  return {
    name: 'probe_endpoint',
    label: 'Probe service endpoint',
    description: 'Checks whether a supplied service endpoint is reachable.',
    parameters: PROBE_PARAMETERS,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      void toolCallId;
      void signal;
      void onUpdate;
      void ctx;
      const endpoint = params?.endpoint;
      const passed =
        typeof endpoint === 'string' && endpoint === correctEndpoint;
      recordVerification({ name: 'probe', passed });
      if (!passed) {
        throw new Error(`probe endpoint unavailable for ${String(endpoint)}`);
      }
      return {
        content: [
          {
            type: 'text',
            text: `endpoint ${endpoint} is reachable (${sentinel})`,
          },
        ],
        details: { passed: true },
      };
    },
  };
}

function createCase({ caseId, fixture, correctEndpoint, prompt, sentinel }) {
  const frozenFixture = Object.freeze({ ...fixture });
  return Object.freeze({
    scenarioClass: SCENARIO_CLASS,
    scenarioId: SCENARIO_ID,
    caseId,
    sentinels: Object.freeze([sentinel]),
    fixture: frozenFixture,
    tools: TOOLS,
    limits: LIMITS,
    storage: 'memory',
    createCustomTools({ workspaceDir, sentinels, recordVerification }) {
      void workspaceDir;
      return [createProbeTool({ sentinels, recordVerification }, correctEndpoint)];
    },
    phases: Object.freeze([{ kind: 'prompt', text: prompt }]),
    evaluate({ workspaceDir, trace }) {
      try {
        const result = readFileSync(join(workspaceDir, 'result.txt'), 'utf8');
        return result.trim() === correctEndpoint && successfulVerification(trace, 'probe');
      } catch {
        return false;
      }
    },
    requiredVerificationSatisfied(prefix) {
      return successfulVerification(prefix, 'probe');
    },
    classifyIntervention(intervention, prefix) {
      return classifyScenarioIntervention(
        intervention,
        prefix,
        (candidatePrefix) => successfulVerification(candidatePrefix, 'probe'),
      );
    },
  });
}

export const SCENARIO_CASES = Object.freeze([
  createCase({
    caseId: 'case-a',
    fixture: {
      'README.md':
        '# Service Endpoint Notes\n\nLegacy operations documentation prominently lists endpoint `alpha` as the fallback endpoint.\n',
      'config/active.txt': 'beta\n',
    },
    correctEndpoint: 'beta',
    prompt:
      'Inspect the available fixture clues, confirm the service endpoint is reachable using probe_endpoint, and write ONLY the reachable endpoint name to result.txt.',
    sentinel: 'BENCH-SENTINEL-probe-endpoint-case-a-7f3a',
  }),
  createCase({
    caseId: 'case-b',
    fixture: {
      'notes.md':
        '# Deployment Notes\n\nThe historical service endpoint was gamma-1.\n',
      'config/env.json': '{"active":"gamma-2"}\n',
    },
    correctEndpoint: 'gamma-2',
    prompt:
      'Inspect the available fixture clues, confirm the service endpoint is reachable using probe_endpoint, and write ONLY the reachable endpoint name to result.txt.',
    sentinel: 'BENCH-SENTINEL-probe-endpoint-case-b-7f3a',
  }),
  createCase({
    caseId: 'case-c',
    fixture: {
      'old-hosts.csv': 'primary,delta-old\n',
      'config/hosts.csv': 'primary,delta-new\n',
    },
    correctEndpoint: 'delta-new',
    prompt:
      'Inspect the available fixture clues, confirm the service endpoint is reachable using probe_endpoint, and write ONLY the reachable endpoint name to result.txt.',
    sentinel: 'BENCH-SENTINEL-probe-endpoint-case-c-7f3a',
  }),
]);

export default SCENARIO_CASES;
