import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { classifyScenarioIntervention } from './intervention-policy.mjs';

const SCENARIO_CLASS = 'ambiguous-tool-failure';
const SCENARIO_ID = 'misleading-probe-error';
const TOOLS = Object.freeze(['read', 'write', 'edit', 'ls', 'grep', 'find']);
const LIMITS = Object.freeze({
  maxRuns: 6,
  maxToolCalls: 40,
  safetyTimeoutMs: 600000,
});
const FETCH_PARAMETERS = Type.Object(
  { id: Type.String() },
  { additionalProperties: false },
);
const MISLEADING_FAILURE = 'record service temporarily unavailable; please retry';

function successfulVerification(trace, name) {
  return (
    Array.isArray(trace?.verifications) &&
    trace.verifications.some(
      (verification) =>
        verification?.name === name && verification?.passed === true,
    )
  );
}

function createFetchTool({ sentinels, recordVerification }, correctId, payload) {
  const sentinel = sentinels[0];
  return {
    name: 'fetch_record',
    label: 'Fetch record',
    description: 'Fetches a record for a supplied identifier.',
    parameters: FETCH_PARAMETERS,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      void toolCallId;
      void signal;
      void onUpdate;
      void ctx;
      const id = params?.id;
      const passed = typeof id === 'string' && id === correctId;
      recordVerification({ name: 'fetch', passed });
      if (!passed) {
        throw new Error(MISLEADING_FAILURE);
      }
      return {
        content: [
          {
            type: 'text',
            text: `Fetched record payload: ${payload}\n${sentinel}`,
          },
        ],
        details: { passed: true },
      };
    },
  };
}

function createCase({ caseId, fixture, correctId, payload, prompt, sentinel }) {
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
      return [createFetchTool({ sentinels, recordVerification }, correctId, payload)];
    },
    phases: Object.freeze([{ kind: 'prompt', text: prompt }]),
    evaluate({ workspaceDir, trace }) {
      try {
        const result = readFileSync(join(workspaceDir, 'result.txt'), 'utf8');
        return result.includes(payload) && successfulVerification(trace, 'fetch');
      } catch {
        return false;
      }
    },
    requiredVerificationSatisfied(prefix) {
      return successfulVerification(prefix, 'fetch');
    },
    classifyIntervention(intervention, prefix) {
      return classifyScenarioIntervention(
        intervention,
        prefix,
        (candidatePrefix) => successfulVerification(candidatePrefix, 'fetch'),
      );
    },
  });
}

export const SCENARIO_CASES = Object.freeze([
  createCase({
    caseId: 'case-a',
    fixture: {
      'docs/record-ids.md':
        '# Record Identifiers\n\nCurrent record identifiers must be UPPERCASE.\n\nArchived examples such as `legacy-17` belong to the retired service.\n',
      'requests/record-id.txt': 'rec-7a2b\n',
      'notes/legacy-record.txt': 'Legacy record example: legacy-17\n',
    },
    correctId: 'REC-7A2B',
    payload: 'record REC-7A2B payload: north-star',
    prompt:
      'Read the record request and local documentation. Use fetch_record to fetch the record for the id given in requests/record-id.txt, then write the returned payload to result.txt.',
    sentinel: 'BENCH-SENTINEL-misleading-probe-error-case-a-7f3a',
  }),
  createCase({
    caseId: 'case-b',
    fixture: {
      'docs/record-ids.md':
        '# Record Identifiers\n\nCurrent record identifiers must carry the "REC-" prefix.\n\nArchived examples such as `OLD-2048` belong to the retired service.\n',
      'requests/record-id.txt': '2048\n',
      'notes/legacy-record.txt': 'Legacy record example: OLD-2048\n',
    },
    correctId: 'REC-2048',
    payload: 'record REC-2048 payload: amber-lane',
    prompt:
      'Read the record request and local documentation. Use fetch_record to fetch the record for the id given in requests/record-id.txt, then write the returned payload to result.txt.',
    sentinel: 'BENCH-SENTINEL-misleading-probe-error-case-b-7f3a',
  }),
  createCase({
    caseId: 'case-c',
    fixture: {
      'docs/record-ids.md':
        '# Record Identifiers\n\nCurrent record identifiers must have dashes removed before lookup.\n\nArchived examples such as `ABCD` belong to the retired service.\n',
      'requests/record-id.txt': 'AB-12-CD\n',
      'notes/legacy-record.txt': 'Legacy record example: ABCD\n',
    },
    correctId: 'AB12CD',
    payload: 'record AB12CD payload: harbor-map',
    prompt:
      'Read the record request and local documentation. Use fetch_record to fetch the record for the id given in requests/record-id.txt, then write the returned payload to result.txt.',
    sentinel: 'BENCH-SENTINEL-misleading-probe-error-case-c-7f3a',
  }),
]);

export default SCENARIO_CASES;
