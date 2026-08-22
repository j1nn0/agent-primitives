import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ContextEvent } from '@earendil-works/pi-coding-agent';
import type { PersistedState } from '../src/extension.js';
import type {
  PersistedStateV1,
  PersistedStateV2,
} from '../src/types.js';
import {
  FakePiHarness,
  customEntry,
} from './harness.js';

type CandidateMessage = ContextEvent['messages'][number];
type TextBlock = { type: 'text'; text: string };
type RecoveryMessage = Extract<CandidateMessage, { role: 'custom' }>;

const STATE_CUSTOM_TYPE = 'agent-context-guard-state';

function item(
  id: string,
  content: string,
  critical = false,
  kind: 'goal' | 'constraint' | 'requirement' | 'decision' | 'fact' = 'fact',
): { id: string; kind: typeof kind; content: string; critical: boolean } {
  return { id, kind, content, critical };
}

function stateData(
  items: readonly unknown[],
  recovery: 'off' | 'critical' = 'off',
): PersistedStateV1 {
  return {
    schemaVersion: 1,
    recovery,
    items: items as PersistedStateV1['items'],
  };
}

function stateDataV2(
  items: readonly unknown[],
  recovery: 'off' | 'critical' = 'off',
  extraction: 'off' | 'automatic' = 'off',
  autoItemIds: readonly string[] = [],
): PersistedStateV2 {
  return {
    schemaVersion: 2,
    recovery,
    extraction,
    items: items as PersistedStateV2['items'],
    autoItemIds,
  };
}

function latestState(harness: FakePiHarness): PersistedState {
  const entry = harness.appendedEntries.at(-1);
  expect(entry?.customType).toBe(STATE_CUSTOM_TYPE);
  return entry?.data as PersistedState;
}

function textMessage(text: string): CandidateMessage {
  return {
    role: 'user',
    content: text,
    timestamp: 1,
  } as CandidateMessage;
}

function inputEvent(
  text: string,
  source: 'interactive' | 'rpc' | 'extension' = 'interactive',
): unknown {
  return { type: 'input', text, source };
}

function extractorResponse(
  text: string,
  stopReason: string = 'stop',
): unknown {
  return {
    stopReason,
    content: [{ type: 'text', text }],
  };
}

function extractorJson(value: unknown): string {
  return JSON.stringify(value);
}

function latestV2State(harness: FakePiHarness): PersistedStateV2 {
  const state = latestState(harness);
  expect(state.schemaVersion).toBe(2);
  return state as PersistedStateV2;
}

async function invokeInput(
  harness: FakePiHarness,
  text: string,
  source: 'interactive' | 'rpc' | 'extension' = 'interactive',
): Promise<void> {
  await harness.invoke('input', inputEvent(text, source));
}

function modelPayload(harness: FakePiHarness): {
  readonly userMessage: string;
  readonly automaticItems: readonly {
    readonly id: string;
    readonly kind: string;
    readonly content: string;
  }[];
} {
  const call = harness.completeCalls.at(-1);
  expect(call).toBeDefined();
  const context = call?.context as {
    readonly messages?: readonly { readonly content?: unknown }[];
  } | undefined;
  const message = context?.messages?.[0];
  expect(typeof message?.content).toBe('string');
  return JSON.parse(message?.content as string) as {
    userMessage: string;
    automaticItems: readonly {
      id: string;
      kind: string;
      content: string;
    }[];
  };
}

function automaticId(kind: string, content: string): string {
  return `auto:${kind}:${createHash('sha256')
    .update(`${kind} ${content}`)
    .digest('hex')
    .slice(0, 12)}`;
}

function block(text: string): TextBlock {
  return { type: 'text', text };
}

function image(data: string): { type: 'image'; data: string; mimeType: string } {
  return { type: 'image', data, mimeType: 'image/png' };
}

function assistantMessage(content: readonly unknown[]): CandidateMessage {
  return {
    role: 'assistant',
    content,
    api: 'test-api',
    provider: 'test-provider',
    model: 'test-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: 'stop',
    timestamp: 2,
  } as CandidateMessage;
}

function toolResultMessage(content: readonly unknown[]): CandidateMessage {
  return {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'test-tool',
    content,
    isError: false,
    timestamp: 3,
  } as CandidateMessage;
}

function customMessage(
  content: string | readonly unknown[],
  details?: unknown,
): CandidateMessage {
  return {
    role: 'custom',
    customType: 'test-message',
    content,
    display: false,
    details,
    timestamp: 4,
  } as CandidateMessage;
}

function contextEvent(messages: readonly CandidateMessage[]): unknown {
  return { type: 'context', messages };
}

function compactEvent(id: string, summary = ''): unknown {
  return {
    type: 'session_compact',
    compactionEntry: {
      id,
      summary,
      firstKeptEntryId: 'entry-1',
    },
  };
}

function verificationMessages(harness: FakePiHarness): readonly string[] {
  return harness.notifyMessages().filter((message) =>
    /\d+ preserved, \d+ lost,/.test(message),
  );
}

async function verifyAfterCompaction(
  harness: FakePiHarness,
  id: string,
  messages: readonly CandidateMessage[],
  summary = '',
): Promise<unknown> {
  await harness.invoke('session_before_compact');
  await harness.invoke('session_compact', compactEvent(id, summary));
  return await harness.invoke('context', contextEvent(messages));
}

async function expectMutationClearsSnapshot(
  mutate: (harness: FakePiHarness) => Promise<void>,
): Promise<void> {
  const harness = new FakePiHarness();
  await harness.start();
  await harness.command('add existing fact Existing protected item');
  const notificationCount = harness.notifications.length;

  await harness.invoke('session_before_compact');
  await mutate(harness);
  await harness.invoke('session_compact', compactEvent('mutated-cycle'));
  await harness.invoke('context', contextEvent([textMessage('')]));

  expect(verificationMessages(harness)).toHaveLength(0);
  expect(harness.notifications.length).toBeGreaterThan(notificationCount);
  expect(harness.notifyMessages().at(-1)).toContain('no pre-compaction snapshot');
}

async function expectSessionResetClearsPending(
  resetEvent: 'session_start' | 'session_shutdown',
): Promise<void> {
  const harness = new FakePiHarness();
  await harness.start();
  await harness.command('add protected fact Pending snapshot item');
  await harness.invoke('session_before_compact');
  const notificationCount = harness.notifications.length;

  if (resetEvent === 'session_start') {
    await harness.invoke('session_start', {
      type: 'session_start',
      reason: 'reload',
    });
  } else {
    await harness.invoke('session_shutdown');
  }
  await harness.invoke('session_compact', compactEvent(`reset-${resetEvent}`));
  await harness.invoke('context', contextEvent([textMessage('Pending snapshot item')]));

  expect(verificationMessages(harness)).toHaveLength(0);
  expect(harness.notifications.length).toBeGreaterThan(notificationCount);
  expect(harness.notifyMessages().at(-1)).toContain('no pre-compaction snapshot');
}

describe('Pi context guard commands', () => {
  it('adds, rejects duplicate ids, lists, and removes protected items', async () => {
    const harness = new FakePiHarness();
    await harness.start();

    await harness.command('add release constraint --critical Keep this release constraint');
    expect(latestState(harness).items).toEqual([
      item(
        'release',
        'Keep this release constraint',
        true,
        'constraint',
      ),
    ]);

    await harness.command('add release constraint Another value');
    expect(harness.notifyMessages().at(-1)).toContain('already exists');
    expect(latestState(harness).items).toHaveLength(1);

    await harness.command('list');
    expect(harness.notifyMessages().at(-1)).toContain('Keep this release constraint');

    await harness.command('remove release');
    expect(latestState(harness).items).toEqual([]);
    await harness.command('list');
    expect(harness.notifyMessages().at(-1)).toContain('no protected items');
  });

  it('persists add, remove, clear confirmation, and recovery changes', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    expect(harness.appendedEntries).toHaveLength(0);

    await harness.command('add first fact First item');
    expect(harness.appendedEntries).toHaveLength(1);
    expect(latestState(harness).items.map((entry) => entry.id)).toEqual(['first']);

    await harness.command('remove first');
    expect(harness.appendedEntries).toHaveLength(2);
    expect(latestState(harness).items).toEqual([]);

    await harness.command('add second fact Second item');
    expect(harness.appendedEntries).toHaveLength(3);
    await harness.command('clear');
    expect(harness.appendedEntries).toHaveLength(3);
    expect(latestState(harness).items).toHaveLength(1);
    expect(harness.notifyMessages().at(-1)).toContain('clear --yes');

    await harness.command('clear --yes');
    expect(harness.appendedEntries).toHaveLength(4);
    expect(latestState(harness).items).toEqual([]);

    await harness.command('recovery critical');
    expect(harness.appendedEntries).toHaveLength(5);
    expect(latestState(harness).recovery).toBe('critical');
  });

  it('reports status, recovery mode, invalid syntax, and invalid kinds through the UI', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add protected constraint --critical Do not change this');
    await harness.command('status');
    const status = harness.notifyMessages().at(-1) ?? '';
    expect(status).toContain('1 items');
    expect(status).toContain('1 critical');
    expect(status).toContain('recovery off');

    await harness.command('recovery critical');
    expect(harness.notifyMessages().at(-1)).toContain('critical');

    await harness.command('unknown-subcommand');
    expect(harness.notifyMessages().at(-1)).toContain('Usage: /context-guard');
    await harness.command('add invalid unsupported Some content');
    expect(harness.notifyMessages().at(-1)).toContain('Usage: /context-guard');
  });
});

describe('Pi context guard persistence', () => {
  it('restores the latest state on session_start', async () => {
    const original = new FakePiHarness();
    await original.start();
    await original.command('add restored goal --critical Continue this goal');
    await original.command('recovery critical');

    const restored = new FakePiHarness(original.getBranch());
    await restored.start();
    await restored.command('status');
    const status = restored.notifyMessages().at(-1) ?? '';
    expect(status).toContain('1 items');
    expect(status).toContain('1 critical');
    expect(status).toContain('recovery critical');
    await restored.command('list');
    expect(restored.notifyMessages().at(-1)).toContain('Continue this goal');
  });

  it('loads only the current branch and does not mix another branch or session', async () => {
    const current = customEntry(
      STATE_CUSTOM_TYPE,
      stateData([item('current', 'Current branch item')]),
    );
    const other = customEntry(
      STATE_CUSTOM_TYPE,
      stateData([item('other', 'Other session item')]),
    );
    const harness = new FakePiHarness([current]);
    await harness.start();
    await harness.command('list');

    const list = harness.notifyMessages().at(-1) ?? '';
    expect(list).toContain('Current branch item');
    expect(list).not.toContain('Other session item');
    expect(harness.getBranch()).not.toContain(other);
  });

  it('discards a malformed latest state without falling back to an older valid state', async () => {
    const oldContent = 'older valid content';
    const malformedContent = 'malformed private content';
    const older = customEntry(
      STATE_CUSTOM_TYPE,
      stateData([item('older', oldContent)]),
    );
    const latest = customEntry(
      STATE_CUSTOM_TYPE,
      stateData([
        {
          id: 'bad',
          kind: 'unsupported',
          content: malformedContent,
          critical: true,
        },
      ]),
    );
    const harness = new FakePiHarness([older, latest]);
    await harness.start();

    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifyMessages()[0]).toContain('discarded');
    expect(harness.notifyMessages()[0]).not.toContain(oldContent);
    expect(harness.notifyMessages()[0]).not.toContain(malformedContent);

    await harness.command('status');
    const status = harness.notifyMessages().at(-1) ?? '';
    expect(status).toContain('0 items');
    expect(status).toContain('degraded yes');
    expect(status).not.toContain(oldContent);
  });
});

describe('Pi context guard compaction lifecycle', () => {
  it('does not snapshot or verify when session_compact has no preceding before event', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add protected fact Current registry item');
    const notificationCount = harness.notifications.length;

    await harness.invoke('session_compact', compactEvent('without-before', 'Current registry item'));
    const result = await harness.invoke(
      'context',
      contextEvent([textMessage('Current registry item')]),
    );

    expect(result).toBeUndefined();
    expect(verificationMessages(harness)).toHaveLength(0);
    expect(harness.notifications.length).toBe(notificationCount + 1);
    expect(harness.notifyMessages().at(-1)).toContain('no pre-compaction snapshot');
  });

  it('verifies once after compaction and consumes the pending verification on the first context event', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add protected fact Keep this literal item');
    const beforeLifecycle = harness.notifications.length;

    const first = await verifyAfterCompaction(
      harness,
      'compaction-once',
      [textMessage('Keep this literal item')],
    );
    const verificationCount = verificationMessages(harness).length;
    const second = await harness.invoke(
      'context',
      contextEvent([textMessage('missing now')]),
    );

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(verificationCount).toBe(1);
    expect(verificationMessages(harness)).toHaveLength(1);
    expect(harness.notifications.length).toBeGreaterThan(beforeLifecycle);
  });

  it('clears pending state on session_start', async () => {
    await expectSessionResetClearsPending('session_start');
  });

  it('clears pending state on session_shutdown', async () => {
    await expectSessionResetClearsPending('session_shutdown');
  });

  it('uses a fresh snapshot after an earlier snapshot is invalidated and a new before event runs', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add first fact First snapshot item');
    await harness.invoke('session_before_compact');
    await harness.command('add second fact Second snapshot item');

    const result = await verifyAfterCompaction(
      harness,
      'fresh-snapshot',
      [textMessage('First snapshot item'), textMessage('Second snapshot item')],
    );

    expect(result).toBeUndefined();
    expect(verificationMessages(harness).at(-1)).toContain('2 preserved');
    expect(verificationMessages(harness).at(-1)).toContain('0 lost');
  });

  it('clears the pending snapshot for add, remove, clear, and recovery changes', async () => {
    await expectMutationClearsSnapshot(async (harness) => {
      await harness.command('add new fact New registry item');
    });
    await expectMutationClearsSnapshot(async (harness) => {
      await harness.command('remove existing');
    });
    await expectMutationClearsSnapshot(async (harness) => {
      await harness.command('clear --yes');
    });
    await expectMutationClearsSnapshot(async (harness) => {
      await harness.command('recovery critical');
    });
  });
});

describe('Pi context guard verification', () => {
  it('uses the system prompt and effective context messages instead of the compaction summary', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add from-system fact effective-system-text');
    await harness.command('add from-summary fact summary-only-text');
    harness.setSystemPrompt('The effective-system-text is in the current system prompt.');

    await verifyAfterCompaction(
      harness,
      'projection',
      [textMessage('ordinary current message')],
      'summary-only-text and effective-system-text were both in the summary',
    );

    const reportNotification = verificationMessages(harness).at(-1) ?? '';
    expect(reportNotification).toContain('1 preserved');
    expect(reportNotification).toContain('1 lost');
  });

  it('projects text blocks from user, assistant, custom, and tool result messages while excluding images', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add user-item fact user-visible-text');
    await harness.command('add assistant-item fact assistant-visible-text');
    await harness.command('add custom-item fact custom-visible-text');
    await harness.command('add tool-item fact tool-visible-text');
    await harness.command('add image-item fact image-only-text');

    const messages = [
      textMessage('user-visible-text'),
      assistantMessage([block('assistant-visible-text'), image('image-only-text')]),
      customMessage([block('custom-visible-text')], { hidden: 'image-only-text' }),
      toolResultMessage([block('tool-visible-text'), image('image-only-text')]),
    ];
    await verifyAfterCompaction(harness, 'all-message-roles', messages);

    const reportNotification = verificationMessages(harness).at(-1) ?? '';
    expect(reportNotification).toContain('4 preserved');
    expect(reportNotification).toContain('1 lost');
  });

  it('reports a paraphrased constraint as lost with the literal verifier', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add public-api constraint --critical Do not alter the public API');

    await verifyAfterCompaction(
      harness,
      'paraphrase',
      [textMessage('The public API must remain unchanged.')],
    );

    const reportNotification = verificationMessages(harness).at(-1) ?? '';
    expect(reportNotification).toContain('0 preserved');
    expect(reportNotification).toContain('1 lost');
    await harness.command('status');
    expect(harness.notifyMessages().at(-1)).toContain('public-api');
  });

  it('reports only by default and injects nothing when recovery is off', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add critical constraint --critical Keep this critical item');

    const result = await verifyAfterCompaction(
      harness,
      'report-only',
      [textMessage('different context')],
    );

    expect(result).toBeUndefined();
    expect(harness.sentMessages).toHaveLength(0);
  });
});

describe('Pi context guard recovery', () => {
  it('recovers only critical failures in one message using the pending snapshot', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add critical-one constraint --critical Before snapshot one');
    await harness.command('add critical-two constraint --critical Before snapshot two');
    await harness.command('add ordinary fact Before snapshot ordinary');
    await harness.command('recovery critical');
    await harness.invoke('session_before_compact');
    await harness.invoke('session_compact', compactEvent('recover-once'));

    await harness.command('remove critical-one');
    await harness.command('add critical-one constraint --critical After snapshot one');
    const result = await harness.invoke(
      'context',
      contextEvent([textMessage('none of the protected text is present')]),
    );
    await Promise.resolve();

    const returnedMessages = (result as { messages?: CandidateMessage[] } | undefined)?.messages;
    expect(returnedMessages).toHaveLength(2);
    const returnedRecovery = returnedMessages?.at(-1) as RecoveryMessage | undefined;
    expect(returnedRecovery?.content).toContain('Before snapshot one');
    expect(returnedRecovery?.content).toContain('Before snapshot two');
    expect(returnedRecovery?.content).not.toContain('Before snapshot ordinary');
    expect(returnedRecovery?.content).not.toContain('After snapshot one');

    expect(harness.sentMessages).toHaveLength(1);
    const sent = harness.sentMessages[0]?.message as {
      details?: { sourceCompactionId?: string; itemIds?: readonly string[] };
    } | undefined;
    expect(sent?.details?.sourceCompactionId).toBe('recover-once');
    expect(sent?.details?.itemIds).toEqual(['critical-one', 'critical-two']);
  });

  it('does not recover twice for one compaction but recovers again for a later compaction', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add critical constraint --critical Restore this item');
    await harness.command('recovery critical');

    const first = await verifyAfterCompaction(
      harness,
      'first-recovery',
      [textMessage('missing')],
    );
    await Promise.resolve();
    const sentAfterFirst = harness.sentMessages.length;
    const notificationCountAfterFirst = verificationMessages(harness).length;

    const second = await harness.invoke('context', contextEvent([textMessage('still missing')]));
    await Promise.resolve();
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect(harness.sentMessages).toHaveLength(sentAfterFirst);
    expect(verificationMessages(harness)).toHaveLength(notificationCountAfterFirst);

    const later = await verifyAfterCompaction(
      harness,
      'later-recovery',
      [textMessage('missing again')],
    );
    await Promise.resolve();
    expect(later).toBeDefined();
    expect(harness.sentMessages).toHaveLength(sentAfterFirst + 1);
    const laterMessage = harness.sentMessages.at(-1)?.message as {
      details?: { sourceCompactionId?: string };
    } | undefined;
    expect(laterMessage?.details?.sourceCompactionId).toBe('later-recovery');
  });
});

describe('Pi context guard privacy', () => {
  it('keeps candidate text, protected content, recovery body, and console output private', async () => {
    const protectedContent = 'PRIVATE-PROTECTED-CONTENT';
    const candidateContent = 'PRIVATE-CANDIDATE-CONTEXT';
    const recoveryBody = `Protected context restored after compaction:\n\n- ${protectedContent}`;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    try {
      const harness = new FakePiHarness();
      await harness.start();
      await harness.command(`add private constraint --critical ${protectedContent}`);
      await harness.command('recovery critical');
      harness.setSystemPrompt(candidateContent);
      await verifyAfterCompaction(
        harness,
        'privacy-lifecycle',
        [textMessage('not protected')],
        `${candidateContent} ${protectedContent}`,
      );
      await Promise.resolve();
      await harness.command('status');

      const uiOutput = [
        ...harness.notifyMessages(),
        ...harness.statuses.map((entry) => `${entry.key} ${entry.text ?? ''}`),
      ].join('\n');
      expect(uiOutput).not.toContain(candidateContent);
      expect(uiOutput).not.toContain(protectedContent);
      expect(uiOutput).not.toContain(recoveryBody);

      const sentMessage = harness.sentMessages[0]?.message as {
        details?: unknown;
      } | undefined;
      const details = JSON.stringify(sentMessage?.details);
      expect(details).not.toContain(candidateContent);
      expect(details).not.toContain(protectedContent);
      expect(details).not.toContain(recoveryBody);

      const malformed = new FakePiHarness([
        customEntry(
          STATE_CUSTOM_TYPE,
          stateData([
            item('malformed', protectedContent, true),
            { id: 'invalid', kind: 'unsupported', content: protectedContent },
          ]),
        ),
      ]);
      await malformed.start();
      expect(malformed.notifyMessages().join('\n')).not.toContain(protectedContent);

      expect(log).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(debug).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
      debug.mockRestore();
    }
  });
});

describe('Pi automatic extraction mode', () => {
  it('is off by default, filters input sources, and makes one call per eligible message', async () => {
    const harness = new FakePiHarness();
    await harness.start();

    await invokeInput(harness, 'Keep this instruction durable.');
    expect(harness.completeCalls).toHaveLength(0);
    await harness.command('extraction');
    expect(harness.notifyMessages().at(-1)).toContain("extraction is 'off'");

    await harness.command('extraction automatic');
    expect(latestV2State(harness).extraction).toBe('automatic');
    harness.setCompletionResponse(
      extractorResponse(
        extractorJson({
          schemaVersion: 1,
          add: [],
          removeAutoItemIds: [],
        }),
      ),
    );

    await invokeInput(harness, 'An eligible interactive message.');
    await invokeInput(harness, 'An eligible rpc message.', 'rpc');
    expect(harness.completeCalls).toHaveLength(2);

    await invokeInput(harness, '/context-guard status');
    await invokeInput(harness, '   ');
    await invokeInput(harness, 'An extension message.', 'extension');
    expect(harness.completeCalls).toHaveLength(2);

    harness.setModelAvailable(false);
    await invokeInput(harness, 'There is no active model.');
    expect(harness.completeCalls).toHaveLength(2);
  });

  it('persists and restores automatic mode', async () => {
    const original = new FakePiHarness();
    await original.start();
    await original.command('extraction automatic');

    const restored = new FakePiHarness(original.getBranch());
    await restored.start();
    await restored.command('extraction');
    expect(restored.notifyMessages().at(-1)).toContain("extraction is 'automatic'");
    restored.setCompletionResponse(
      extractorResponse(
        extractorJson({
          schemaVersion: 1,
          add: [],
          removeAutoItemIds: [],
        }),
      ),
    );
    await invokeInput(restored, 'One restored eligible message.');
    expect(restored.completeCalls).toHaveLength(1);
  });

  it('accepts every allowed kind and only persists exact source substrings', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('extraction automatic');

    const message =
      'Goal: ship safely. Constraint: do not alter the public API. Requirement: keep tests green. Decision: use JSON.';
    const output = {
      schemaVersion: 1,
      add: [
        { content: 'Goal: ship safely.', kind: 'goal', critical: true },
        { content: 'Constraint: do not alter the public API.', kind: 'constraint' },
        { content: 'Requirement: keep tests green.', kind: 'requirement', critical: false },
        { content: 'Decision: use JSON.', kind: 'decision' },
      ],
      removeAutoItemIds: [],
    };
    harness.setCompletionResponse(
      extractorResponse(`\`\`\`json\n${extractorJson(output)}\n\`\`\``),
    );

    await invokeInput(harness, message);

    const state = latestV2State(harness);
    expect(state.items.map((entry) => entry.id)).toEqual([
      automaticId('goal', 'Goal: ship safely.'),
      automaticId('constraint', 'Constraint: do not alter the public API.'),
      automaticId('requirement', 'Requirement: keep tests green.'),
      automaticId('decision', 'Decision: use JSON.'),
    ]);
    expect(state.items.map((entry) => entry.critical)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(state.autoItemIds).toEqual(state.items.map((entry) => entry.id));

    await harness.command('list');
    const list = harness.notifyMessages().at(-1) ?? '';
    expect(list).toContain('[auto]');
    expect(list).toContain('Goal: ship safely.');
    await harness.command('status');
    const status = harness.notifyMessages().at(-1) ?? '';
    expect(status).toContain('0 manual');
    expect(status).toContain('4 automatic');
    expect(status).toContain('extraction automatic');
    expect(status).toContain('Last extraction: added 4, retired 0.');
  });

  it('rejects invalid output atomically', async () => {
    const cases: readonly { response: unknown; message: string }[] = [
      {
        response: extractorResponse(
          extractorJson({
            schemaVersion: 1,
            add: [{ content: 'A fact', kind: 'fact' }],
            removeAutoItemIds: [],
          }),
        ),
        message: 'A fact',
      },
      {
        response: extractorResponse(
          extractorJson({
            schemaVersion: 1,
            add: [{ content: 'The API must remain unchanged.', kind: 'constraint' }],
            removeAutoItemIds: [],
          }),
        ),
        message: 'Do not alter the public API.',
      },
      {
        response: extractorResponse(
          extractorJson({
            schemaVersion: 1,
            add: [{ content: 'not present', kind: 'constraint' }],
            removeAutoItemIds: [],
          }),
        ),
        message: 'A valid user message.',
      },
      {
        response: extractorResponse(
          extractorJson({
            schemaVersion: 1,
            add: [{ content: 'unsupported', kind: 'unsupported' }],
            removeAutoItemIds: [],
          }),
        ),
        message: 'unsupported',
      },
      {
        response: extractorResponse(
          extractorJson({
            schemaVersion: 1,
            add: [{ content: 'A nonboolean flag', kind: 'constraint', critical: 'yes' }],
            removeAutoItemIds: [],
          }),
        ),
        message: 'A nonboolean flag',
      },
      {
        response: extractorResponse(
          extractorJson({
            schemaVersion: 2,
            add: [],
            removeAutoItemIds: [],
          }),
        ),
        message: 'Unknown schema version.',
      },
      {
        response: extractorResponse('{ malformed json'),
        message: 'Malformed JSON.',
      },
      {
        response: extractorResponse(
          extractorJson({
            schemaVersion: 1,
            add: Array.from({ length: 9 }, (_, index) => ({
              content: `Rule ${index}`,
              kind: 'constraint',
            })),
            removeAutoItemIds: [],
          }),
        ),
        message: 'Rule 0 Rule 1 Rule 2 Rule 3 Rule 4 Rule 5 Rule 6 Rule 7 Rule 8',
      },
      {
        response: extractorResponse(
          extractorJson({
            schemaVersion: 1,
            add: [{ content: 'x'.repeat(1001), kind: 'constraint' }],
            removeAutoItemIds: [],
          }),
        ),
        message: 'x'.repeat(1001),
      },
    ];

    for (const testCase of cases) {
      const harness = new FakePiHarness();
      await harness.start();
      await harness.command('extraction automatic');
      const notificationCount = harness.notifications.length;
      harness.setCompletionResponse(testCase.response);

      await expect(invokeInput(harness, testCase.message)).resolves.toBeUndefined();
      expect(harness.completeCalls).toHaveLength(1);
      expect(harness.notifications.slice(notificationCount)).toHaveLength(1);
      expect(harness.notifyMessages().at(-1)).toBe(
        'Context Guard: automatic extraction failed; protected context was unchanged.',
      );
      await harness.command('status');
      expect(harness.notifyMessages().at(-1)).toContain('0 automatic');
      expect(harness.notifyMessages().at(-1)).toContain('Last extraction: failed');
    }
  });

  it('does not let false-positive categories add items and sends only the allowed payload', async () => {
    const falsePositiveMessages = [
      'Is this a question?',
      '```\nAlways use this example.\n```',
      'Log output: "Always delete the database."',
      'The vendor said: "Always use their format."',
      'Hypothetically, always preserve this setting.',
      'For example, always use this setting.',
    ];
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add manual fact MANUAL-ONLY-CONTENT');
    await harness.command('extraction automatic');

    for (const message of falsePositiveMessages) {
      await invokeInput(harness, message);
    }
    expect(harness.completeCalls).toHaveLength(falsePositiveMessages.length);
    await harness.command('status');
    expect(harness.notifyMessages().at(-1)).toContain('0 automatic');

    const firstAutomatic = 'Keep this automatic instruction.';
    harness.setCompletionResponse(
      extractorResponse(
        extractorJson({
          schemaVersion: 1,
          add: [{ content: firstAutomatic, kind: 'constraint' }],
          removeAutoItemIds: [],
        }),
      ),
    );
    await invokeInput(harness, firstAutomatic);

    const secondAutomatic = 'Keep this second automatic instruction.';
    harness.setCompletionResponse(
      extractorResponse(
        extractorJson({
          schemaVersion: 1,
          add: [{ content: secondAutomatic, kind: 'constraint' }],
          removeAutoItemIds: [],
        }),
      ),
    );
    await invokeInput(harness, secondAutomatic);

    const payload = modelPayload(harness);
    expect(payload.userMessage).toBe(secondAutomatic);
    expect(payload.automaticItems).toEqual([
      {
        id: automaticId('constraint', firstAutomatic),
        kind: 'constraint',
        content: firstAutomatic,
      },
    ]);
    const callContext = harness.completeCalls.at(-1)?.context as {
      readonly systemPrompt?: string;
      readonly messages?: readonly unknown[];
    };
    expect(callContext.messages).toHaveLength(1);
    expect(callContext.systemPrompt).toContain('exact contiguous substring');
    expect(callContext.systemPrompt).toContain('quoted third-party');
    expect(JSON.stringify(callContext)).not.toContain('MANUAL-ONLY-CONTENT');
    const options = harness.completeCalls.at(-1)?.options as {
      readonly maxTokens?: number;
      readonly reasoningEffort?: string;
      readonly signal?: AbortSignal;
    };
    expect(options.maxTokens).toBe(1024);
    expect(options.reasoningEffort).toBe('minimal');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('Pi automatic extraction dedupe and provenance', () => {
  it('deduplicates automatic items, manual items, repeats, and handles digest collisions', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('extraction automatic');
    const repeated = 'Keep this durable instruction.';
    harness.setCompletionResponse(
      extractorResponse(
        extractorJson({
          schemaVersion: 1,
          add: [
            { content: repeated, kind: 'constraint' },
            { content: repeated, kind: 'constraint', critical: true },
          ],
          removeAutoItemIds: [],
        }),
      ),
    );
    await invokeInput(harness, repeated);
    expect(latestV2State(harness).items).toHaveLength(1);
    expect(latestV2State(harness).autoItemIds).toEqual([
      automaticId('constraint', repeated),
    ]);
    const entriesAfterFirst = harness.appendedEntries.length;

    await invokeInput(harness, repeated);
    expect(latestV2State(harness).items).toHaveLength(1);
    expect(harness.appendedEntries).toHaveLength(entriesAfterFirst);

    const manual = new FakePiHarness();
    await manual.start();
    await manual.command('add manual constraint Keep this manual item.');
    await manual.command('extraction automatic');
    manual.setCompletionResponse(
      extractorResponse(
        extractorJson({
          schemaVersion: 1,
          add: [{ content: 'Keep this manual item.', kind: 'constraint' }],
          removeAutoItemIds: [],
        }),
      ),
    );
    await invokeInput(manual, 'Keep this manual item.');
    expect(latestV2State(manual).items).toHaveLength(1);
    expect(latestV2State(manual).autoItemIds).toEqual([]);

    const collision = new FakePiHarness();
    await collision.start();
    const collisionContent = 'Collision-safe instruction.';
    const collisionId = automaticId('constraint', collisionContent);
    await collision.command(`add ${collisionId} fact Occupying manual item`);
    await collision.command('extraction automatic');
    collision.setCompletionResponse(
      extractorResponse(
        extractorJson({
          schemaVersion: 1,
          add: [{ content: collisionContent, kind: 'constraint' }],
          removeAutoItemIds: [],
        }),
      ),
    );
    await invokeInput(collision, collisionContent);
    expect(latestV2State(collision).items.map((entry) => entry.id)).toEqual([
      collisionId,
      `${collisionId}-2`,
    ]);
    expect(latestV2State(collision).autoItemIds).toEqual([`${collisionId}-2`]);
  });

  it('allows automatic retirement but never retires manual or unknown ids', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('extraction automatic');
    const original = 'Keep the original API contract.';
    harness.setCompletionResponse(
      extractorResponse(
        extractorJson({
          schemaVersion: 1,
          add: [{ content: original, kind: 'constraint' }],
          removeAutoItemIds: [],
        }),
      ),
    );
    await invokeInput(harness, original);
    const originalId = automaticId('constraint', original);
    await harness.command('add manual fact Manual authority remains.');

    const replacement = 'Use the replacement API contract.';
    harness.setCompletionResponse(
      extractorResponse(
        extractorJson({
          schemaVersion: 1,
          add: [{ content: replacement, kind: 'constraint' }],
          removeAutoItemIds: [originalId],
        }),
      ),
    );
    await invokeInput(harness, `Replace it: ${replacement}`);
    let state = latestV2State(harness);
    expect(state.items.map((entry) => entry.content)).toEqual([
      'Manual authority remains.',
      replacement,
    ]);
    expect(state.autoItemIds).toEqual([automaticId('constraint', replacement)]);

    const manualId = 'manual';
    harness.setCompletionResponse(
      extractorResponse(
        extractorJson({
          schemaVersion: 1,
          add: [],
          removeAutoItemIds: [manualId],
        }),
      ),
    );
    await invokeInput(harness, 'Do not retire manual authority.');
    expect(harness.notifyMessages().at(-1)).toContain('automatic extraction failed');
    state = latestV2State(harness);
    expect(state.items.map((entry) => entry.id)).toContain(manualId);

    harness.setCompletionResponse(
      extractorResponse(
        extractorJson({
          schemaVersion: 1,
          add: [],
          removeAutoItemIds: ['auto:constraint:does-not-exist'],
        }),
      ),
    );
    await invokeInput(harness, 'Unknown retirement id.');
    expect(harness.notifyMessages().at(-1)).toContain('automatic extraction failed');
    expect(latestV2State(harness).items).toHaveLength(2);

    await harness.command(`remove ${automaticId('constraint', replacement)}`);
    expect(latestV2State(harness).autoItemIds).toEqual([]);
    await harness.command('list');
    expect(harness.notifyMessages().at(-1)).toContain('[manual]');
  });

  it('rejects a malformed add without applying a valid retirement', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('extraction automatic');
    const original = 'Keep this item until explicitly withdrawn.';
    harness.setCompletionResponse(
      extractorResponse(
        extractorJson({
          schemaVersion: 1,
          add: [{ content: original, kind: 'constraint' }],
          removeAutoItemIds: [],
        }),
      ),
    );
    await invokeInput(harness, original);
    const originalId = automaticId('constraint', original);
    const entriesBefore = harness.appendedEntries.length;

    harness.setCompletionResponse(
      extractorResponse(
        extractorJson({
          schemaVersion: 1,
          add: [{ content: 'not in the user message', kind: 'constraint' }],
          removeAutoItemIds: [originalId],
        }),
      ),
    );
    await invokeInput(harness, 'Withdraw the original item.');
    expect(harness.appendedEntries).toHaveLength(entriesBefore);
    expect(latestV2State(harness).items.map((entry) => entry.id)).toEqual([
      originalId,
    ]);
    expect(latestV2State(harness).autoItemIds).toEqual([originalId]);
  });
});

describe('Pi automatic extraction persistence and lifecycle', () => {
  it('round-trips v2 mode and provenance, and drops stale provenance ids', async () => {
    const original = new FakePiHarness();
    await original.start();
    await original.command('add manual fact Manual item.');
    await original.command('extraction automatic');
    const automatic = 'Persist this automatic item.';
    original.setCompletionResponse(
      extractorResponse(
        extractorJson({
          schemaVersion: 1,
          add: [{ content: automatic, kind: 'decision' }],
          removeAutoItemIds: [],
        }),
      ),
    );
    await invokeInput(original, automatic);
    const saved = latestV2State(original);
    expect(saved.schemaVersion).toBe(2);
    expect(saved.extraction).toBe('automatic');
    expect(saved.autoItemIds).toEqual([automaticId('decision', automatic)]);

    const restored = new FakePiHarness(original.getBranch());
    await restored.start();
    await restored.command('list');
    const list = restored.notifyMessages().at(-1) ?? '';
    expect(list).toContain('[manual]');
    expect(list).toContain('[auto]');
    await restored.command('status');
    expect(restored.notifyMessages().at(-1)).toContain('1 manual');
    expect(restored.notifyMessages().at(-1)).toContain('1 automatic');
    expect(restored.notifyMessages().at(-1)).toContain("extraction automatic");
  });

  it('drops stale provenance ids while loading v2', async () => {
    const stale = new FakePiHarness([
      customEntry(
        STATE_CUSTOM_TYPE,
        stateDataV2(
          [item('auto-one', 'Persisted automatic item.', false, 'constraint')],
          'off',
          'automatic',
          ['auto-one', 'stale-id'],
        ),
      ),
    ]);
    await stale.start();
    await stale.command('list');
    expect(stale.notifyMessages().at(-1)).toContain('[auto]');
    expect(stale.notifyMessages().at(-1)).not.toContain('stale-id');
  });

  it('migrates v1 as manual with extraction off and degrades malformed v2 without fallback', async () => {
    const legacy = new FakePiHarness([
      customEntry(
        STATE_CUSTOM_TYPE,
        stateData([item('legacy', 'Legacy item', true, 'constraint')]),
      ),
    ]);
    await legacy.start();
    expect(legacy.notifications).toHaveLength(0);
    await legacy.command('list');
    expect(legacy.notifyMessages().at(-1)).toContain('[manual]');
    await legacy.command('status');
    expect(legacy.notifyMessages().at(-1)).toContain("extraction off");
    expect(legacy.notifyMessages().at(-1)).toContain('degraded no');
    await invokeInput(legacy, 'Legacy input should not extract.');
    expect(legacy.completeCalls).toHaveLength(0);

    const older = customEntry(
      STATE_CUSTOM_TYPE,
      stateDataV2([item('older', 'Older valid item')]),
    );
    const malformed = customEntry(STATE_CUSTOM_TYPE, {
      schemaVersion: 2,
      recovery: 'off',
      extraction: 'automatic',
      items: [item('bad', 'Malformed latest item')],
      autoItemIds: 'not-an-array',
    });
    const broken = new FakePiHarness([older, malformed]);
    await broken.start();
    expect(broken.notifications).toHaveLength(1);
    expect(broken.notifyMessages()[0]).toContain('discarded');
    expect(broken.notifyMessages()[0]).not.toContain('Older valid item');
    await broken.command('status');
    expect(broken.notifyMessages().at(-1)).toContain('0 items');
    expect(broken.notifyMessages().at(-1)).toContain('degraded yes');

    const unknown = new FakePiHarness([
      customEntry(STATE_CUSTOM_TYPE, {
        schemaVersion: 99,
        recovery: 'off',
        items: [],
      }),
    ]);
    await unknown.start();
    expect(unknown.notifications).toHaveLength(1);
    expect(unknown.notifyMessages()[0]).toContain('discarded');
  });

  it('clears the pending snapshot after an automatic mutation and captures a fresh one next time', async () => {
    const harness = new FakePiHarness();
    await harness.start();
    await harness.command('add existing fact Existing snapshot item.');
    await harness.command('extraction automatic');
    await harness.invoke('session_before_compact');

    const automatic = 'Automatic snapshot item.';
    harness.setCompletionResponse(
      extractorResponse(
        extractorJson({
          schemaVersion: 1,
          add: [{ content: automatic, kind: 'constraint' }],
          removeAutoItemIds: [],
        }),
      ),
    );
    await invokeInput(harness, automatic);
    await harness.invoke('session_compact', compactEvent('invalidated'));
    await harness.invoke('context', contextEvent([textMessage('')]));
    expect(harness.notifyMessages().at(-1)).toContain('no pre-compaction snapshot');
    expect(verificationMessages(harness)).toHaveLength(0);

    await harness.invoke('session_before_compact');
    await harness.invoke('session_compact', compactEvent('fresh'));
    await harness.invoke(
      'context',
      contextEvent([textMessage('Existing snapshot item.'), textMessage(automatic)]),
    );
    expect(verificationMessages(harness).at(-1)).toContain('2 preserved');
  });
});

describe('Pi automatic extraction failures', () => {
  it('keeps the turn alive, leaves the registry unchanged, and emits one concise warning', async () => {
    const cases: readonly {
      readonly configure: (harness: FakePiHarness) => void;
      readonly expectedInput?: string;
    }[] = [
      {
        configure: (harness): void => {
          harness.setCompletionError(new Error('provider secret must not leak'));
        },
        expectedInput: 'PRIVATE-USER-MESSAGE',
      },
      {
        configure: (harness): void => {
          harness.setCompletionResponse(extractorResponse('{"schemaVersion":1}'));
        },
      },
      {
        configure: (harness): void => {
          harness.setCompletionResponse({
            stopReason: 'aborted',
            content: [{ type: 'text', text: '{}' }],
          });
        },
      },
      {
        configure: (harness): void => {
          harness.setCompletionResponse({ stopReason: 'stop', content: [] });
        },
      },
      {
        configure: (harness): void => {
          harness.setCompletionResponse({
            stopReason: 'stop',
            content: [{ type: 'thinking', thinking: 'not text' }],
          });
        },
      },
    ];

    for (const testCase of cases) {
      const harness = new FakePiHarness();
      await harness.start();
      await harness.command('add manual fact Manual item survives.');
      await harness.command('extraction automatic');
      const notificationCount = harness.notifications.length;
      testCase.configure(harness);

      await expect(invokeInput(harness, testCase.expectedInput ?? 'Failure input.'))
        .resolves.toBeUndefined();
      expect(harness.completeCalls).toHaveLength(1);
      expect(harness.notifications.slice(notificationCount)).toHaveLength(1);
      expect(harness.notifyMessages().at(-1)).toBe(
        'Context Guard: automatic extraction failed; protected context was unchanged.',
      );
      expect(harness.notifyMessages().at(-1)).not.toContain('provider secret');
      expect(harness.notifyMessages().at(-1)).not.toContain('PRIVATE-USER-MESSAGE');
      await harness.command('status');
      expect(harness.notifyMessages().at(-1)).toContain('1 manual');
      expect(harness.notifyMessages().at(-1)).toContain('0 automatic');
      expect(harness.notifyMessages().at(-1)).toContain('Last extraction: failed');
      await expect(
        harness.invoke('context', contextEvent([textMessage('still alive')])),
      ).resolves.toBeUndefined();
    }
  });
});
