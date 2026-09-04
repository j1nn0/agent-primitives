import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyScenarioIntervention } from './intervention-policy.mjs';

const SCENARIO_CLASS = 'context-compaction';
const SCENARIO_ID = 'compaction-carryover';
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

function createCase({ caseId, fixture, outputPath, expectedOutput, phase1, phase2, sentinel }) {
  const frozenFixture = Object.freeze({ ...fixture });
  const phases = Object.freeze([
    Object.freeze({ kind: 'prompt', text: phase1 }),
    Object.freeze({ kind: 'compact' }),
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
    storage: 'memory',
    createCustomTools({ workspaceDir, sentinels, recordVerification }) {
      void workspaceDir;
      return [createNoteProgressTool(sentinels[0], recordVerification)];
    },
    phases,
    evaluate({ workspaceDir, trace }) {
      return (
        trace?.compaction?.real === true &&
        checkOutput(workspaceDir, outputPath, expectedOutput)
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

const CASE_A_FIRST_LINE = 'FIRST-LINE-EMBER-42';
const CASE_A_OUTPUT_PATH = 'answer.md';
const CASE_A_EXPECTED_OUTPUT = `${CASE_A_FIRST_LINE}\n`;
const CASE_A_BRIEFING = `# Briefing

Create "${CASE_A_OUTPUT_PATH}".
Its first line must be exactly "${CASE_A_FIRST_LINE}".
Write no other lines.
`;

const CASE_B_OUTPUT_PATH = 'ordered-list.txt';
const CASE_B_EXPECTED_OUTPUT = 'item-cinder\nitem-maple\nitem-quartz\n';
const CASE_B_BRIEFING = `# Briefing

Read labels.txt and create "${CASE_B_OUTPUT_PATH}".
Name each line by prefixing the lowercase label with "item-".
Order the generated lines alphabetically by the original label.
Write one generated name per line with no header or extra lines.
`;

const CASE_C_OUTPUT_PATH = 'transformed.txt';
const CASE_C_EXPECTED_OUTPUT = 'ryhpez\nssom\ndihcro\n';
const CASE_C_BRIEFING = `# Briefing

For every value in data.txt, apply these two transformations in order:
1. Trim surrounding whitespace and lowercase the value.
2. Reverse the resulting characters.
Write the transformed values to "${CASE_C_OUTPUT_PATH}", one per line in the original input order, with no extra lines.
`;

const PHASE_ONE_PROMPT =
  'Read briefing.md carefully and remember its output contract for the next phase. Do not create or modify the requested output during this briefing phase.';
const CASE_A_PHASE_TWO_PROMPT =
  'Now create the required output file from the briefing you read earlier. Do not change briefing.md; call note_progress after the artifact is ready.';
const CASE_B_PHASE_TWO_PROMPT =
  'Now generate the requested list from the earlier briefing and source material. Call note_progress after the artifact is ready.';
const CASE_C_PHASE_TWO_PROMPT =
  'Now produce the transformed values requested in the earlier briefing. Call note_progress after the artifact is ready.'

export const SCENARIO_CASES = Object.freeze([
  createCase({
    caseId: 'case-a',
    fixture: {
      'briefing.md': CASE_A_BRIEFING,
    },
    outputPath: CASE_A_OUTPUT_PATH,
    expectedOutput: CASE_A_EXPECTED_OUTPUT,
    phase1: PHASE_ONE_PROMPT,
    phase2: CASE_A_PHASE_TWO_PROMPT,
    sentinel: 'BENCH-SENTINEL-compaction-carryover-case-a-91d4',
  }),
  createCase({
    caseId: 'case-b',
    fixture: {
      'briefing.md': CASE_B_BRIEFING,
      'labels.txt': 'Quartz\nCinder\nMaple\n',
    },
    outputPath: CASE_B_OUTPUT_PATH,
    expectedOutput: CASE_B_EXPECTED_OUTPUT,
    phase1: PHASE_ONE_PROMPT,
    phase2: CASE_B_PHASE_TWO_PROMPT,
    sentinel: 'BENCH-SENTINEL-compaction-carryover-case-b-91d4',
  }),
  createCase({
    caseId: 'case-c',
    fixture: {
      'briefing.md': CASE_C_BRIEFING,
      'data.txt': '  Zephyr \nMoss\n Orchid\n',
    },
    outputPath: CASE_C_OUTPUT_PATH,
    expectedOutput: CASE_C_EXPECTED_OUTPUT,
    phase1: PHASE_ONE_PROMPT,
    phase2: CASE_C_PHASE_TWO_PROMPT,
    sentinel: 'BENCH-SENTINEL-compaction-carryover-case-c-91d4',
  }),
]);

export default SCENARIO_CASES;
