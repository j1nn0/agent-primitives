import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyScenarioIntervention } from './intervention-policy.mjs';

const SCENARIO_CLASS = 'session-resume';
const SCENARIO_ID = 'resume-carryover';
const TOOLS = Object.freeze(['read', 'write', 'edit', 'ls', 'grep', 'find']);
const LIMITS = Object.freeze({
  maxRuns: 8,
  maxToolCalls: 50,
  safetyTimeoutMs: 900000,
});
const NOTE_PARAMETERS = Object.freeze({
  type: 'object',
  properties: {},
  additionalProperties: false,
});

function readWorkspaceFile(workspaceDir, relativePath) {
  try {
    return readFileSync(join(workspaceDir, relativePath), 'utf8');
  } catch {
    return undefined;
  }
}

function hasPostResumeMutation(trace) {
  const runs = Array.isArray(trace?.runs) ? trace.runs : [];
  const postResumeRunIndexes = new Set(
    runs
      .filter(
        (run) =>
          Number.isSafeInteger(run?.index) &&
          run.index >= 0 &&
          run.rootIndex === 1,
      )
      .map((run) => run.index),
  );
  const toolEvents = Array.isArray(trace?.toolEvents) ? trace.toolEvents : [];
  return toolEvents.some(
    (event) =>
      (event?.toolName === 'write' || event?.toolName === 'edit') &&
      Number.isSafeInteger(event?.runIndex) &&
      event?.blockedBySupervisor !== true &&
      event?.isError !== true &&
      event?.mutation !== false &&
      postResumeRunIndexes.has(event.runIndex),
  );
}

function checkOutput(workspaceDir, outputPath, expectedOutput) {
  return readWorkspaceFile(workspaceDir, outputPath) === expectedOutput;
}

function createNoteProgressTool(sentinel, recordVerification) {
  return {
    name: 'note_progress',
    label: 'Record progress note',
    description: 'Records a deterministic progress note without changing the workspace.',
    parameters: NOTE_PARAMETERS,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      void toolCallId;
      void params;
      void signal;
      void onUpdate;
      void ctx;
      recordVerification({ name: 'note', passed: true });
      return {
        content: [{ type: 'text', text: `Progress noted (${sentinel}).` }],
        details: { passed: true },
      };
    },
  };
}

function createCase({ caseId, fixture, outputPath, expectedOutput, phase2, sentinel }) {
  const frozenFixture = Object.freeze({ ...fixture });
  const phases = Object.freeze([
    Object.freeze({
      kind: 'prompt',
      text:
        'Read assignment.md carefully and remember the assignment for the next phase. Do not create or modify any artifact during this assignment phase.',
    }),
    Object.freeze({ kind: 'resume' }),
    Object.freeze({ kind: 'prompt', text: phase2 }),
  ]);
  return Object.freeze({
    scenarioClass: SCENARIO_CLASS,
    scenarioId: SCENARIO_ID,
    caseId,
    sentinels: Object.freeze([sentinel]),
    fixture: frozenFixture,
    tools: TOOLS,
    limits: LIMITS,
    storage: 'file',
    createCustomTools({ workspaceDir, sentinels, recordVerification }) {
      void workspaceDir;
      return [createNoteProgressTool(sentinels[0], recordVerification)];
    },
    phases,
    evaluate({ workspaceDir, trace }) {
      return (
        checkOutput(workspaceDir, outputPath, expectedOutput) &&
        hasPostResumeMutation(trace)
      );
    },
    requiredVerificationSatisfied() {
      return true;
    },
    classifyIntervention(intervention, prefix) {
      return classifyScenarioIntervention(intervention, prefix, () => true);
    },
  });
}

const CASE_A_IDENTIFIER = 'ASSIGNED-ORBIT-73';
const CASE_A_OUTPUT_PATH = 'assigned.txt';
const CASE_A_EXPECTED_OUTPUT = `${CASE_A_IDENTIFIER}\n`;
const CASE_A_ASSIGNMENT = `# Assignment

The assigned identifier is "${CASE_A_IDENTIFIER}".
During the work phase, create assigned.txt containing exactly that identifier followed by a newline.
Do not create or modify any other file until the work phase.
`;

const CASE_B_OUTPUT_PATH = 'release-note.txt';
const CASE_B_MARKER = 'MARKER-SAFFRON-61';
const CASE_B_EXPECTED_OUTPUT = `${CASE_B_MARKER}\n`;
const CASE_B_ASSIGNMENT = `# Assignment

During the work phase, create the file named "${CASE_B_OUTPUT_PATH}".
Its content must be exactly "${CASE_B_MARKER}" followed by a newline.
Do not create or modify any other file until the work phase.
`;

const CASE_C_OUTPUT_PATH = 'order.txt';
const CASE_C_EXPECTED_OUTPUT = 'delta\nalpha\nbravo\n';
const CASE_C_ASSIGNMENT = `# Assignment

During the work phase, create order.txt with these three labels in exactly this order:
delta
alpha
bravo
Do not create or modify any other file until the work phase.
`;

const CASE_A_PHASE_TWO_PROMPT =
  'Now create assigned.txt with the identifier from the assignment you read earlier, then call note_progress after the artifact is ready.';
const CASE_B_PHASE_TWO_PROMPT =
  'Now carry out the earlier assignment by creating the assigned file with its assigned marker, then call note_progress after the artifact is ready.'
const CASE_C_PHASE_TWO_PROMPT =
  'Now create order.txt in the order specified by the assignment you read earlier, then call note_progress after the artifact is ready.';

export const SCENARIO_CASES = Object.freeze([
  createCase({
    caseId: 'case-a',
    fixture: {
      'assignment.md': CASE_A_ASSIGNMENT,
    },
    outputPath: CASE_A_OUTPUT_PATH,
    expectedOutput: CASE_A_EXPECTED_OUTPUT,
    phase2: CASE_A_PHASE_TWO_PROMPT,
    sentinel: 'BENCH-SENTINEL-resume-carryover-case-a-6b82',
  }),
  createCase({
    caseId: 'case-b',
    fixture: {
      'assignment.md': CASE_B_ASSIGNMENT,
    },
    outputPath: CASE_B_OUTPUT_PATH,
    expectedOutput: CASE_B_EXPECTED_OUTPUT,
    phase2: CASE_B_PHASE_TWO_PROMPT,
    sentinel: 'BENCH-SENTINEL-resume-carryover-case-b-6b82',
  }),
  createCase({
    caseId: 'case-c',
    fixture: {
      'assignment.md': CASE_C_ASSIGNMENT,
    },
    outputPath: CASE_C_OUTPUT_PATH,
    expectedOutput: CASE_C_EXPECTED_OUTPUT,
    phase2: CASE_C_PHASE_TWO_PROMPT,
    sentinel: 'BENCH-SENTINEL-resume-carryover-case-c-6b82',
  }),
]);

export default SCENARIO_CASES;
