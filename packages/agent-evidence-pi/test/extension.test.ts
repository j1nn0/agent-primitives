import { describe, expect, it } from 'vitest';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import {
  judgeEvidence,
  type EvidenceVerdict,
} from '@j1nn0/agent-evidence';
import { COMMAND_NAME } from '../src/command.js';
import { formatEvidenceState } from '../src/display.js';
import {
  ADAPTER_SCHEMA_VERSION,
  addClaim,
  addEvidence,
  isFreshState,
  STATE_CUSTOM_TYPE,
  type EvidenceState,
  validateCandidateState,
} from '../src/state.js';
import { TOOL_NAMES } from '../src/tools.js';
import { TOOL_NAMES as PROGRESS_TOOL_NAMES } from '../../agent-progress-pi/src/tools.js';
import { TOOL_NAMES as STATE_TOOL_NAMES } from '../../agent-state-pi/src/tools.js';
import { STATE_CUSTOM_TYPE as CONTEXT_STATE_CUSTOM_TYPE } from '../../context-guard-pi/src/state.js';
import { TOOL_NAMES as RETRY_TOOL_NAMES } from '../../agent-retry-guard-pi/src/tools.js';
import { TOOL_NAMES as HANDOFF_TOOL_NAMES } from '../../agent-handoff-pi/src/tools.js';
import { TOOL_NAMES as BUDGET_TOOL_NAMES } from '../../agent-budget-pi/src/tools.js';
import { FakePiHarness, type AppendedEntry } from './harness.js';

function text(result: AgentToolResult<unknown>): string {
  const content = result.content[0];
  if (content === undefined || content.type !== 'text') {
    throw new Error('expected a text tool result');
  }
  return content.text;
}

function lastAppended(harness: FakePiHarness): AppendedEntry {
  const entry = harness.appendedEntries.at(-1);
  if (entry === undefined) {
    throw new Error('expected an appended entry');
  }
  return entry;
}

function customEntry(data: unknown, customType = STATE_CUSTOM_TYPE): unknown {
  return { type: 'custom', customType, data };
}

function payload(
  claims: readonly unknown[] = [],
  evidence: readonly unknown[] = [],
  extra: Record<string, unknown> = {},
): unknown {
  return {
    schemaVersion: ADAPTER_SCHEMA_VERSION,
    claims,
    evidence,
    ...extra,
  };
}

function verdictFrom(result: AgentToolResult<unknown>): EvidenceVerdict {
  const output = text(result);
  const line = output.split('\n').at(-1);
  if (line === undefined) {
    throw new Error(`expected a formatted verdict: ${output}`);
  }
  return JSON.parse(line) as EvidenceVerdict;
}

async function addClaimFor(
  harness: FakePiHarness,
  id: string,
  evidenceId: string,
  subject?: string,
): Promise<void> {
  await harness.executeTool(
    'agent_evidence_add_claim',
    subject === undefined
      ? { id, requires: [{ evidenceId }] }
      : { id, requires: [{ evidenceId, subject }] },
  );
}

async function addEvidenceFor(
  harness: FakePiHarness,
  id: string,
  outcome: 'confirmed' | 'refuted' | 'unknown',
  subject?: string,
): Promise<void> {
  await harness.executeTool(
    'agent_evidence_add_evidence',
    subject === undefined ? { id, outcome } : { id, outcome, subject },
  );
}

describe('Agent Evidence Pi registration and namespaces', () => {
  it('registers exactly one command, seven tools, and one lifecycle handler', () => {
    const harness = new FakePiHarness();

    expect([...harness.commands.keys()]).toEqual([COMMAND_NAME]);
    expect([...harness.tools.keys()]).toEqual(TOOL_NAMES);
    expect(harness.tools.size).toBe(7);
    expect([...harness.handlers.keys()]).toEqual(['session_start']);
    expect([...harness.tools.values()].map((tool) => tool.label)).toEqual([
      'Agent Evidence: get',
      'Agent Evidence: add claim',
      'Agent Evidence: remove claim',
      'Agent Evidence: add evidence',
      'Agent Evidence: replace evidence',
      'Agent Evidence: remove evidence',
      'Agent Evidence: judge',
    ]);

    expect(harness.tools.get('agent_evidence_get')?.parameters).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    expect(harness.tools.get('agent_evidence_add_claim')?.parameters).toEqual({
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Caller-supplied opaque claim identifier, preserved exactly.',
        },
        requires: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              evidenceId: {
                type: 'string',
                description:
                  'Caller-supplied opaque evidence identifier required by this claim.',
              },
              subject: {
                type: 'string',
                description:
                  'Optional caller-supplied opaque subject, matched exactly when judging.',
              },
            },
            required: ['evidenceId'],
            additionalProperties: false,
          },
        },
      },
      required: ['id', 'requires'],
      additionalProperties: false,
    });

    const descriptions = [...harness.tools.values()].map(
      (tool) => tool.description,
    );
    expect(
      descriptions.every((description) =>
        description.includes('does not collect evidence automatically'),
      ),
    ).toBe(true);
    expect(
      descriptions.every((description) =>
        description.includes('execute commands'),
      ),
    ).toBe(true);
    expect(
      descriptions.every((description) =>
        description.includes('generate claims or subjects'),
      ),
    ).toBe(true);
    expect(
      descriptions.every((description) =>
        description.includes('judge automatically'),
      ),
    ).toBe(true);
    expect(
      descriptions.every((description) =>
        description.includes('map to other primitives'),
      ),
    ).toBe(true);
    expect(
      descriptions.every((description) => description.includes('verify truth')),
    ).toBe(true);
    expect(harness.tools.get('agent_evidence_judge')?.description).toContain(
      'only when this tool is explicitly called',
    );
  });

  it('uses namespaces distinct from the other adapters\' namespaces', () => {
    const existingCommands = new Set([
      'context-guard',
      'agent-state',
      'agent-progress',
      'agent-retry',
      'agent-handoff',
      'agent-budget',
      'agent-tool-policy',
    ]);
    expect(existingCommands.has(COMMAND_NAME)).toBe(false);

    const existingTools = new Set<string>([
      ...STATE_TOOL_NAMES,
      ...PROGRESS_TOOL_NAMES,
      ...RETRY_TOOL_NAMES,
      ...HANDOFF_TOOL_NAMES,
      ...BUDGET_TOOL_NAMES,
    ]);
    expect(TOOL_NAMES.every((name) => !existingTools.has(name))).toBe(true);
    expect(TOOL_NAMES.every((name) => name.startsWith('agent_evidence_'))).toBe(
      true,
    );

    const existingEntryTypes = new Set([
      CONTEXT_STATE_CUSTOM_TYPE,
      'agent-state-state',
      'agent-progress-state',
      'agent-retry-state',
      'agent-handoff-state',
      'agent-budget-state',
      'agent-tool-policy-state',
    ]);
    expect(existingEntryTypes.has(STATE_CUSTOM_TYPE)).toBe(false);
  });
});

describe('Agent Evidence Pi raw state and mutations', () => {
  it('starts without automatic judgments or persistence and gives identical raw summaries', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    expect(harness.appendedEntries).toHaveLength(0);

    await harness.command('');
    const bare = harness.notifications.at(-1)?.message;
    await harness.command('status');
    const status = harness.notifications.at(-1)?.message;
    const get = text(await harness.executeTool('agent_evidence_get'));

    expect(status).toBe(bare);
    expect(get).toBe(status);
    expect(status).toContain('0 claims and 0 evidence records');
    expect(status).toContain('Claims: none.');
    expect(status).toContain('Evidence: none.');
    expect(status).not.toContain('[ok]');
    expect(status).not.toContain('unsupported');
    expect(status).not.toContain('contradicted');
    expect(status).not.toContain('missing_evidence');
    expect(harness.appendedEntries).toHaveLength(0);
  });

  it('adds claims through tools and commands, and rejects invalid candidates without appending', async () => {
    const harness = new FakePiHarness();
    const added = await harness.executeTool('agent_evidence_add_claim', {
      id: 'tool-claim',
      requires: [{ evidenceId: 'e1', subject: 'subject-1' }],
    });
    expect(text(added)).toContain('recorded claim "tool-claim"');
    expect(harness.appendedEntries).toHaveLength(1);
    expect(lastAppended(harness).data).toEqual(
      payload([
        {
          id: 'tool-claim',
          requires: [{ evidenceId: 'e1', subject: 'subject-1' }],
        },
      ]),
    );

    const duplicate = await harness.executeTool('agent_evidence_add_claim', {
      id: 'tool-claim',
      requires: [{ evidenceId: 'e2' }],
    });
    expect(text(duplicate)).toContain('change rejected as invalid');
    expect(text(duplicate)).toContain('duplicate ids');
    expect(harness.appendedEntries).toHaveLength(1);

    const empty = await harness.executeTool('agent_evidence_add_claim', {
      id: 'empty-claim',
      requires: [],
    });
    expect(text(empty)).toContain('change rejected as invalid');
    expect(text(empty)).toContain('empty requirements');
    expect(harness.appendedEntries).toHaveLength(1);

    const missing = await harness.executeTool('agent_evidence_add_claim', {
      id: 'missing-requires',
    });
    expect(text(missing)).toContain('Usage: /agent-evidence');
    expect(harness.appendedEntries).toHaveLength(1);

    await harness.command(
      'claim add command-claim --require e2 --subject s2 --require e3',
    );
    expect(harness.appendedEntries).toHaveLength(2);
    expect(lastAppended(harness).data).toEqual(
      payload([
        {
          id: 'tool-claim',
          requires: [{ evidenceId: 'e1', subject: 'subject-1' }],
        },
        {
          id: 'command-claim',
          requires: [{ evidenceId: 'e2', subject: 's2' }, { evidenceId: 'e3' }],
        },
      ]),
    );

    await harness.command('claim add bad --require e --subject one two');
    expect(harness.notifications.at(-1)?.message).toContain(
      'Usage: /agent-evidence',
    );
    expect(harness.appendedEntries).toHaveLength(2);
  });

  it('removes existing claims and warns for unknown claims without appending', async () => {
    const harness = new FakePiHarness();
    await addClaimFor(harness, 'claim-1', 'e1');
    expect(harness.appendedEntries).toHaveLength(1);

    const removed = await harness.executeTool('agent_evidence_remove_claim', {
      id: 'claim-1',
    });
    expect(text(removed)).toContain('removed claim "claim-1"');
    expect(harness.appendedEntries).toHaveLength(2);
    expect(lastAppended(harness).data).toEqual(payload());

    const unknown = await harness.executeTool('agent_evidence_remove_claim', {
      id: 'not-present',
    });
    expect(text(unknown)).toContain('unknown claim "not-present"');
    expect(harness.appendedEntries).toHaveLength(2);

    await harness.command('claim remove not-present');
    expect(harness.notifications.at(-1)?.message).toContain(
      'unknown claim "not-present"',
    );
    expect(harness.appendedEntries).toHaveLength(2);
  });

  it('adds, replaces, and removes evidence with explicit persistence semantics', async () => {
    const harness = new FakePiHarness();
    const added = await harness.executeTool('agent_evidence_add_evidence', {
      id: 'e1',
      outcome: 'confirmed',
      subject: 'old-subject',
    });
    expect(text(added)).toContain('recorded evidence "e1"');
    expect(harness.appendedEntries).toHaveLength(1);

    const duplicate = await harness.executeTool('agent_evidence_add_evidence', {
      id: 'e1',
      outcome: 'refuted',
    });
    expect(text(duplicate)).toContain('change rejected as invalid');
    expect(harness.appendedEntries).toHaveLength(1);

    const replaced = await harness.executeTool(
      'agent_evidence_replace_evidence',
      { id: 'e1', outcome: 'unknown' },
    );
    expect(text(replaced)).toContain('replaced evidence "e1"');
    expect(harness.appendedEntries).toHaveLength(2);
    expect(lastAppended(harness).data).toEqual(
      payload([], [{ id: 'e1', outcome: 'unknown' }]),
    );

    const unknownReplace = await harness.executeTool(
      'agent_evidence_replace_evidence',
      { id: 'not-present', outcome: 'confirmed' },
    );
    expect(text(unknownReplace)).toContain('unknown evidence "not-present"');
    expect(harness.appendedEntries).toHaveLength(2);


    const commandHarness = new FakePiHarness();
    await commandHarness.command('evidence add command-evidence confirmed subject old');
    await commandHarness.command(
      'evidence replace command-evidence refuted subject new subject',
    );
    expect(lastAppended(commandHarness).data).toEqual(
      payload([], [
        { id: 'command-evidence', outcome: 'refuted', subject: 'new subject' },
      ]),
    );

    await harness.command('evidence add e2 refuted subject command subject');
    expect(harness.appendedEntries).toHaveLength(3);
    expect(lastAppended(harness).data).toEqual(
      payload([], [
        { id: 'e1', outcome: 'unknown' },
        { id: 'e2', outcome: 'refuted', subject: 'command subject' },
      ]),
    );

    const removed = await harness.executeTool('agent_evidence_remove_evidence', {
      id: 'e2',
    });
    expect(text(removed)).toContain('removed evidence "e2"');
    expect(harness.appendedEntries).toHaveLength(4);

    const unknownRemove = await harness.executeTool(
      'agent_evidence_remove_evidence',
      { id: 'not-present' },
    );
    expect(text(unknownRemove)).toContain('unknown evidence "not-present"');
    expect(harness.appendedEntries).toHaveLength(4);

    await harness.command('evidence remove not-present');
    expect(harness.notifications.at(-1)?.message).toContain(
      'unknown evidence "not-present"',
    );
    expect(harness.appendedEntries).toHaveLength(4);
  });

  it('uses the core as a validator for invalid candidate state', () => {
    const state: EvidenceState = {
      claims: [],
      evidence: [{ id: 'e1', outcome: 'confirmed' }],
    };
    const duplicate = addEvidence(state, {
      id: 'e1',
      outcome: 'unknown',
    });
    expect(duplicate).toEqual({ changed: false, reason: 'invalid' });
    expect(state).toEqual({
      claims: [],
      evidence: [{ id: 'e1', outcome: 'confirmed' }],
    });

    expect(
      validateCandidateState(
        [{ id: 'claim', requires: [] }],
        state.evidence,
      ),
    ).toBe(false);

    const emptyClaim = addClaim(state, 'claim', []);
    expect(emptyClaim).toEqual({ changed: false, reason: 'invalid' });
  });
});

describe('Agent Evidence Pi explicit judge behavior', () => {
  const scenarios: readonly {
    readonly name: string;
    readonly claims: readonly unknown[];
    readonly evidence: readonly unknown[];
    readonly expected: EvidenceVerdict;
  }[] = [
    {
      name: 'supported',
      claims: [{ id: 'c-supported', requires: [{ evidenceId: 'e' }] }],
      evidence: [{ id: 'e', outcome: 'confirmed' }],
      expected: {
        claims: [{ claimId: 'c-supported', outcome: 'supported' }],
      },
    },
    {
      name: 'contradicted',
      claims: [{ id: 'c-contradicted', requires: [{ evidenceId: 'e' }] }],
      evidence: [{ id: 'e', outcome: 'refuted' }],
      expected: {
        claims: [
          {
            claimId: 'c-contradicted',
            outcome: 'contradicted',
            evidenceId: 'e',
          },
        ],
      },
    },

    {
      name: 'matching subject',
      claims: [
        {
          id: 'c-matching-subject',
          requires: [{ evidenceId: 'e', subject: 'same' }],
        },
      ],
      evidence: [{ id: 'e', outcome: 'confirmed', subject: 'same' }],
      expected: {
        claims: [
          { claimId: 'c-matching-subject', outcome: 'supported' },
        ],
      },
    },
    {
      name: 'unconfirmed evidence',
      claims: [{ id: 'c-unknown', requires: [{ evidenceId: 'e' }] }],
      evidence: [{ id: 'e', outcome: 'unknown' }],
      expected: {
        claims: [
          {
            claimId: 'c-unknown',
            outcome: 'unsupported',
            reason: 'unconfirmed_evidence',
            evidenceId: 'e',
          },
        ],
      },
    },
    {
      name: 'missing evidence',
      claims: [{ id: 'c-missing', requires: [{ evidenceId: 'e' }] }],
      evidence: [],
      expected: {
        claims: [
          {
            claimId: 'c-missing',
            outcome: 'unsupported',
            reason: 'missing_evidence',
            evidenceId: 'e',
          },
        ],
      },
    },
    {
      name: 'subject mismatch',
      claims: [
        {
          id: 'c-subject',
          requires: [{ evidenceId: 'e', subject: 'expected' }],
        },
      ],
      evidence: [{ id: 'e', outcome: 'confirmed', subject: 'actual' }],
      expected: {
        claims: [
          {
            claimId: 'c-subject',
            outcome: 'unsupported',
            reason: 'subject_mismatch',
            evidenceId: 'e',
          },
        ],
      },
    },
    {
      name: 'stale refuted evidence does not contradict',
      claims: [
        {
          id: 'c-stale',
          requires: [{ evidenceId: 'e', subject: 'expected' }],
        },
      ],
      evidence: [{ id: 'e', outcome: 'refuted', subject: 'old' }],
      expected: {
        claims: [
          {
            claimId: 'c-stale',
            outcome: 'unsupported',
            reason: 'subject_mismatch',
            evidenceId: 'e',
          },
        ],
      },
    },
  ];

  it.each(scenarios)(
    'delegates the $name scenario to the core without appending',
    async ({ claims, evidence, expected }) => {
      const harness = new FakePiHarness([
        customEntry(payload(claims, evidence)),
      ]);
      await harness.start();
      expect(harness.appendedEntries).toHaveLength(0);

      const toolResult = await harness.executeTool('agent_evidence_judge');
      expect(verdictFrom(toolResult)).toEqual(
        judgeEvidence({ claims, evidence }),
      );
      expect(verdictFrom(toolResult)).toEqual(expected);
      expect(text(toolResult)).toContain('c-');
      expect(harness.appendedEntries).toHaveLength(0);

      await harness.command('judge');
      expect(harness.notifications.at(-1)?.message).toContain(
        JSON.stringify(expected),
      );
      expect(harness.appendedEntries).toHaveLength(0);
    },
  );

  it('returns the core reasons in human-readable judge output', async () => {
    const harness = new FakePiHarness([
      customEntry(
        payload(
          [{ id: 'c', requires: [{ evidenceId: 'missing' }] }],
          [],
        ),
      ),
    ]);
    await harness.start();
    await harness.command('judge');
    const output = harness.notifications.at(-1)?.message ?? '';
    expect(output).toContain('[..] c unsupported (missing_evidence: missing)');
    expect(output.split('\n').at(-1)).toBe(
      JSON.stringify({
        claims: [
          {
            claimId: 'c',
            outcome: 'unsupported',
            reason: 'missing_evidence',
            evidenceId: 'missing',
          },
        ],
      }),
    );
  });
});

describe('Agent Evidence Pi clear and persistence behavior', () => {
  it('requires confirmation and clears both collections with one actual-change append', async () => {
    const harness = new FakePiHarness();
    await addClaimFor(harness, 'c', 'e');
    await addEvidenceFor(harness, 'e', 'confirmed');
    expect(harness.appendedEntries).toHaveLength(2);

    await harness.command('clear');
    expect(harness.notifications.at(-1)).toEqual({
      message: expect.stringContaining('requires confirmation'),
      type: 'warning',
    });
    expect(harness.appendedEntries).toHaveLength(2);

    await harness.command('clear --yes');
    expect(harness.appendedEntries).toHaveLength(3);
    expect(lastAppended(harness).data).toEqual(payload());
    expect(text(await harness.executeTool('agent_evidence_get'))).toContain(
      '0 claims and 0 evidence records',
    );

    await harness.command('clear --yes');
    expect(harness.appendedEntries).toHaveLength(3);

    const fresh = new FakePiHarness();
    await fresh.command('clear --yes');
    expect(fresh.appendedEntries).toHaveLength(0);
    expect(isFreshState({ claims: [], evidence: [] })).toBe(true);
  });

  it('round-trips raw state and preserves absent optional subjects', async () => {
    const first = new FakePiHarness();
    await addClaimFor(first, 'c', 'e', 'subject');
    await addEvidenceFor(first, 'e', 'confirmed');
    const persisted = first.getBranch();

    const resumed = new FakePiHarness(persisted);
    await resumed.start('resume');
    expect(resumed.notifications).toHaveLength(0);
    expect(text(await resumed.executeTool('agent_evidence_get'))).toBe(
      formatEvidenceState({
        claims: [{ id: 'c', requires: [{ evidenceId: 'e', subject: 'subject' }] }],
        evidence: [{ id: 'e', outcome: 'confirmed' }],
      }),
    );
    expect(lastAppended(first).data).toEqual(
      payload(
        [{ id: 'c', requires: [{ evidenceId: 'e', subject: 'subject' }] }],
        [{ id: 'e', outcome: 'confirmed' }],
      ),
    );
  });

  it('uses only the newest matching entry and starts fresh once when it is malformed', async () => {
    const valid = payload(
      [{ id: 'older', requires: [{ evidenceId: 'e' }] }],
      [{ id: 'e', outcome: 'confirmed' }],
    );
    const malformedEntries: readonly unknown[] = [
      customEntry({ schemaVersion: 2, claims: [], evidence: [] }),
      customEntry(
        payload(
          [
            { id: 'duplicate', requires: [{ evidenceId: 'e' }] },
            { id: 'duplicate', requires: [{ evidenceId: 'e2' }] },
          ],
          [],
        ),
      ),
      customEntry(
        payload(
          [],
          [
            { id: 'duplicate', outcome: 'confirmed' },
            { id: 'duplicate', outcome: 'unknown' },
          ],
        ),
      ),
      customEntry({ schemaVersion: 1, claims: {}, evidence: [] }),
      customEntry({ schemaVersion: 1, claims: [], evidence: [], unexpected: true }),
    ];

    for (const malformed of malformedEntries) {
      const harness = new FakePiHarness([customEntry(valid), malformed]);
      await harness.start();
      expect(harness.notifications).toEqual([
        {
          message:
            'Agent Evidence: persisted state was invalid; starting with fresh state.',
          type: 'warning',
        },
      ]);
      expect(harness.appendedEntries).toHaveLength(0);
      expect(text(await harness.executeTool('agent_evidence_get'))).toContain(
        '0 claims and 0 evidence records',
      );
    }
  });

  it('ignores unrelated entries in a new session without warning', async () => {
    const harness = new FakePiHarness([
      customEntry(
        payload(
          [{ id: 'other', requires: [{ evidenceId: 'e' }] }],
          [{ id: 'e', outcome: 'confirmed' }],
        ),
        CONTEXT_STATE_CUSTOM_TYPE,
      ),
      { type: 'message', text: 'unrelated session content' },
    ]);
    await harness.start();
    expect(harness.notifications).toHaveLength(0);
    expect(harness.appendedEntries).toHaveLength(0);
    expect(text(await harness.executeTool('agent_evidence_get'))).toContain(
      '0 claims and 0 evidence records',
    );
  });
});
